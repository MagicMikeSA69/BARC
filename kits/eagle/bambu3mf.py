#!/usr/bin/env python3
"""
bambu3mf.py - write a Bambu-Studio-compatible multi-object, multi-colour 3MF.

The package layout, XML element/attribute names, UUID suffixes, id numbering and
file order mirror BambuStudio's exporter in
    src/libslic3r/Format/bbs_3mf.cpp  (class _BBS_3MF_Exporter)
and were cross-checked against a real BambuStudio 02.00.02.01 export
(resources/calib/pressure_advance/auto_pa_line_dual.3mf in the BambuStudio repo).

Bambu Studio's normal "Save project" uses
    SaveStrategy::SplitModel | SaveStrategy::ShareMesh   (Plater.cpp)
where SplitModel = 0x1000 | ProductionExt.  That produces:

    [Content_Types].xml
    Metadata/plate_1.png, plate_1_small.png            (thumbnails; see below)
    3D/3dmodel.model                                   (metadata + component objects + <build>)
    3D/_rels/3dmodel.model.rels                        (one rel per 3D/Objects/*.model)
    3D/Objects/object_<k>.model                        (one file per object, holds the mesh(es))
    Metadata/project_settings.config                   (JSON; filament_colour lives here)
    Metadata/model_settings.config                     (XML; per-object name/extruder, parts, plate)
    Metadata/cut_information.xml
    Metadata/slice_info.config                         (header only when unsliced)
    _rels/.rels

Public API
----------
    write_bambu_3mf(path, objects, **options) -> dict (summary)

    objects: iterable of (name, trimesh.Trimesh, filament_index, hex_colour)
        filament_index is 1-based (Bambu's "extruder" number = filament slot).
        hex_colour is "#RRGGBB" and becomes filament_colour[filament_index-1].

    read_bambu_3mf_summary(path) -> dict   (small independent reader used for validation)

Run `python bambu3mf.py OUT.3mf` to produce the 4-object sample.

What is confirmed vs. not
-------------------------
Confirmed from bbs_3mf.cpp AND the real export: file names/order, namespaces, metadata names
(sorted, std::map), object/volume id numbering, all five UUID suffixes, transform encodings
(12-value column-major in .model, 16-value row-major 'matrix' in model_settings.config),
model_settings.config keys (name, extruder, face_count, part/subtype, mesh_stat, plate/plater_id/
plater_name/locked/thumbnail_file, model_instance/object_id/instance_id/identify_id, assemble_item),
project_settings.config JSON header (version/name/from) and filament_colour as a string array,
importer behaviour: extruder > len(filament_settings_id) is reset to 1, so filament_settings_id is
written with one entry per filament slot; slice_info.config is header-only when unsliced;
Metadata/plate_N.json is only the sliced pattern bbox (PlateBBoxData) and is NOT required.

NOT confirmed (could not test, no Bambu Studio binary and wiki.bambulab.com blocked by the proxy):
  * that Bambu Studio opens this file without any "preset not found" prompt - the preset names
    filament_settings_id / printer_settings_id / print_settings_id are plausible X1C defaults but
    were not validated against a preset database; pass your own or None.
  * identify_id values: Bambu writes the instance ObjectID (opaque); any positive int is assumed OK.
  * whether omitting the 435 other project_settings keys triggers substitution warnings
    (load_from_json is called with substitutions enabled, so unknown/missing keys are tolerated
    in code, but the UI behaviour was not observed).
  * "Application" is set to "BambuStudio-02.00.02.01" because the importer only treats the file as
    a Bambu project (loads plates/config) when the value starts with "BambuStudio-"; this is what
    OrcaSlicer does as well, but it is technically a claim about the generating program.
"""
from __future__ import annotations

import datetime as _dt
import io
import json
import struct
import zipfile
import zlib
from typing import Iterable, Sequence
from xml.sax.saxutils import escape as _xml_escape

import numpy as np

try:  # trimesh is only needed for the Trimesh type / sample generation
    import trimesh  # noqa: F401
except Exception:  # pragma: no cover
    trimesh = None

# ----------------------------------------------------------------------------
# Constants copied from bbs_3mf.cpp
# ----------------------------------------------------------------------------
CONTENT_TYPES_FILE = "[Content_Types].xml"
RELATIONSHIPS_FILE = "_rels/.rels"
MODEL_FILE = "3D/3dmodel.model"
MODEL_RELS_FILE = "3D/_rels/3dmodel.model.rels"
OBJECT_FILE_FMT = "3D/Objects/object_%d.model"
THUMBNAIL_FILE = "Metadata/plate_1.png"
THUMBNAIL_SMALL_FILE = "Metadata/plate_1_small.png"
BBS_PROJECT_CONFIG_FILE = "Metadata/project_settings.config"
BBS_MODEL_CONFIG_FILE = "Metadata/model_settings.config"
SLICE_INFO_CONFIG_FILE = "Metadata/slice_info.config"
CUT_INFORMATION_FILE = "Metadata/cut_information.xml"

NS_CORE = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
NS_BBS = "http://schemas.bambulab.com/package/2021"
NS_PROD = "http://schemas.microsoft.com/3dmanufacturing/production/2015/06"
REL_3DMODEL = "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"
REL_THUMB = "http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"
REL_COVER_MID = "http://schemas.bambulab.com/package/2021/cover-thumbnail-middle"
REL_COVER_SMALL = "http://schemas.bambulab.com/package/2021/cover-thumbnail-small"

# UUID suffixes (bbs_3mf.cpp lines 288-293)
OBJECT_UUID_SUFFIX = "-61cb-4c03-9d28-80fed5dfa1dc"      # component-holder object (own mesh)
OBJECT_UUID_SUFFIX2 = "-71cb-4c03-9d28-80fed5dfa1dc"     # component-holder object sharing a mesh
SUB_OBJECT_UUID_SUFFIX = "-81cb-4c03-9d28-80fed5dfa1dc"  # mesh object inside 3D/Objects/*.model
COMPONENT_UUID_SUFFIX = "-b206-40ff-9872-83e8017abed1"
BUILD_UUID = "2c7c17d8-22b5-4d84-8835-1976022ea369"
BUILD_UUID_SUFFIX = "-b1ec-4553-aec9-835e5b724bb4"

BBS_3MF_VERSION_KEY = "BambuStudio:3mfVersion"
VERSION_BBS_3MF = 1
DEFAULT_APPLICATION = "BambuStudio-02.00.02.01"   # importer sets m_is_bbl_3mf only if it starts with "BambuStudio-"


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
def _hex8(v: int) -> str:
    return "%08x" % (int(v) & 0xFFFFFFFF)


def _fmt_f(f: float) -> str:
    """Round-trippable float, shortest form; Bambu uses sprintf("%.9g")."""
    s = "%.9g" % float(f)
    return s


def _transform_3mf(m: np.ndarray) -> str:
    """12-number 3MF transform: column-major 3x4 (for c in 0..3: for r in 0..2)."""
    m = np.asarray(m, dtype=float)
    vals = [m[r, c] for c in range(4) for r in range(3)]
    return " ".join(_fmt_f(v) for v in vals)


def _matrix_16(m: np.ndarray) -> str:
    """16-number row-major 4x4, as written to model_settings.config key 'matrix'."""
    m = np.asarray(m, dtype=float)
    return " ".join(repr(float(m[r, c])) if m[r, c] != int(m[r, c]) else str(int(m[r, c]))
                    for r in range(4) for c in range(4))


def _validate_hex(colour: str) -> str:
    c = colour.strip()
    if not c.startswith("#"):
        c = "#" + c
    if len(c) != 7:
        raise ValueError("colour must be #RRGGBB, got %r" % colour)
    int(c[1:], 16)
    return c.upper()


def _png_bytes(rgb: np.ndarray) -> bytes:
    """Minimal PNG encoder (8-bit RGB), pure python + zlib."""
    h, w, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[y].astype(np.uint8).tobytes() for y in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


def _render_top_view(placed: Sequence[tuple[np.ndarray, np.ndarray, str]],
                     bed: tuple[float, float], size: int) -> bytes:
    """Crude top-down raster of the plate: each triangle flat-filled with its filament colour."""
    img = np.full((size, size, 3), 235, dtype=np.uint8)
    sx = size / bed[0]
    sy = size / bed[1]
    for verts, faces, colour in placed:
        rgb = np.array([int(colour[1:3], 16), int(colour[3:5], 16), int(colour[5:7], 16)], dtype=np.uint8)
        px = np.stack([verts[:, 0] * sx, (bed[1] - verts[:, 1]) * sy], axis=1)
        for f in faces:
            tri = px[f]
            x0, y0 = np.floor(tri.min(axis=0)).astype(int)
            x1, y1 = np.ceil(tri.max(axis=0)).astype(int)
            x0, y0 = max(x0, 0), max(y0, 0)
            x1, y1 = min(x1, size - 1), min(y1, size - 1)
            if x1 < x0 or y1 < y0:
                continue
            xs, ys = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
            p = np.stack([xs.ravel() + 0.5, ys.ravel() + 0.5], axis=1)
            a, b, c = tri
            d = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])
            if abs(d) < 1e-9:
                continue
            w0 = ((b[0] - p[:, 0]) * (c[1] - p[:, 1]) - (c[0] - p[:, 0]) * (b[1] - p[:, 1])) / d
            w1 = ((c[0] - p[:, 0]) * (a[1] - p[:, 1]) - (a[0] - p[:, 0]) * (c[1] - p[:, 1])) / d
            w2 = 1 - w0 - w1
            inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
            img[p[inside, 1].astype(int), p[inside, 0].astype(int)] = rgb
    return _png_bytes(img)


# ----------------------------------------------------------------------------
# Part writers (one per archive entry, same order as _BBS_3MF_Exporter)
# ----------------------------------------------------------------------------
def _content_types_xml() -> str:
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
            ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'
            ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n'
            ' <Default Extension="png" ContentType="image/png"/>\n'
            ' <Default Extension="gcode" ContentType="text/x.gcode"/>\n'
            '</Types>')


def _root_rels_xml(with_thumbnails: bool) -> str:
    s = ('<?xml version="1.0" encoding="UTF-8"?>\n'
         '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
         ' <Relationship Target="/%s" Id="rel-1" Type="%s"/>\n' % (MODEL_FILE, REL_3DMODEL))
    if with_thumbnails:
        s += (' <Relationship Target="/%s" Id="rel-2" Type="%s"/>\n' % (THUMBNAIL_FILE, REL_THUMB)
              + ' <Relationship Target="/%s" Id="rel-4" Type="%s"/>\n' % (THUMBNAIL_FILE, REL_COVER_MID)
              + '<Relationship Target="/%s" Id="rel-5" Type="%s"/>\n' % (THUMBNAIL_SMALL_FILE, REL_COVER_SMALL))
    return s + "</Relationships>"


def _rels_xml(targets: Sequence[str], rel_type: str) -> str:
    s = ('<?xml version="1.0" encoding="UTF-8"?>\n'
         '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n')
    for i, t in enumerate(targets, 1):
        s += ' <Relationship Target="/%s" Id="rel-%d" Type="%s"/>\n' % (_xml_escape(t), i, rel_type)
    return s + "</Relationships>"


def _model_header(production_ext: bool) -> str:
    s = ('<?xml version="1.0" encoding="UTF-8"?>\n'
         '<model unit="millimeter" xml:lang="en-US" xmlns="%s" xmlns:BambuStudio="%s"' % (NS_CORE, NS_BBS))
    if production_ext:
        s += ' xmlns:p="%s" requiredextensions="p"' % NS_PROD
    return s + ">\n"


def _mesh_object_xml(volume_id: int, uuid_hex: str | None, verts: np.ndarray, faces: np.ndarray) -> str:
    out = ['  <object id="%d"' % volume_id]
    if uuid_hex is not None:
        out.append(' p:UUID="%s%s"' % (uuid_hex, SUB_OBJECT_UUID_SUFFIX))
    out.append(' type="model">\n   <mesh>\n    <vertices>\n')
    out.extend('     <vertex x="%s" y="%s" z="%s"/>\n' % (_fmt_f(x), _fmt_f(y), _fmt_f(z)) for x, y, z in verts)
    out.append('    </vertices>\n    <triangles>\n')
    out.extend('     <triangle v1="%d" v2="%d" v3="%d"/>\n' % (a, b, c) for a, b, c in faces)
    out.append('    </triangles>\n   </mesh>\n  </object>\n')
    return "".join(out)


# ----------------------------------------------------------------------------
# Main writer
# ----------------------------------------------------------------------------
def write_bambu_3mf(path: str,
                    objects: Iterable[tuple[str, "trimesh.Trimesh", int, str]],
                    *,
                    layout: str = "split",
                    bed_size: tuple[float, float] = (256.0, 256.0),
                    auto_arrange: bool = True,
                    positions: Sequence[tuple[float, float]] | None = None,
                    spacing: float = 10.0,
                    thumbnails: bool = True,
                    thumbnail_size: int = 256,
                    application: str = DEFAULT_APPLICATION,
                    title: str = "",
                    project_settings_extra: dict | None = None,
                    filament_settings_id: str = "Bambu PLA Basic @BBL X1C",
                    filament_type: str = "PLA",
                    printer_settings_id: str | None = "Bambu Lab X1 Carbon 0.4 nozzle",
                    printer_model: str | None = "Bambu Lab X1 Carbon",
                    print_settings_id: str | None = "0.20mm Standard @BBL X1C",
                    bed_type: str = "Textured PEI Plate",
                    plate_name: str = "",
                    source_file: str | None = None) -> dict:
    """
    Write a Bambu-Studio-compatible 3MF.

    layout="split"  : Bambu's own SplitModel|ProductionExt layout (3D/Objects/object_k.model).
    layout="single" : all meshes inside 3D/3dmodel.model, no production extension
                      (what BambuStudio writes when SplitModel is off; also what plain 3MF readers prefer).

    Each object becomes one ModelObject with one 'normal_part' volume. Meshes are re-centred on
    their bounding-box centre (Bambu stores volumes in object-local coordinates) and the <build>
    item transform places them on the plate with min-z = 0.
    """
    if layout not in ("split", "single"):
        raise ValueError("layout must be 'split' or 'single'")
    production_ext = layout == "split"
    objs = list(objects)
    if not objs:
        raise ValueError("no objects")

    # ---- normalise input -----------------------------------------------------------------
    prepared = []
    for name, mesh, fil, colour in objs:
        fil = int(fil)
        if fil < 1:
            raise ValueError("filament_index is 1-based (got %d)" % fil)
        v = np.asarray(mesh.vertices, dtype=np.float64)
        f = np.asarray(mesh.faces, dtype=np.int64)
        if len(v) == 0 or len(f) == 0:
            raise ValueError("object %r has an empty mesh" % name)
        if f.shape[1] != 3:
            raise ValueError("object %r is not triangulated" % name)
        centre = (v.min(axis=0) + v.max(axis=0)) / 2.0
        v_local = v - centre                      # Bambu: volume mesh centred, instance offset in <item>
        prepared.append(dict(name=str(name), verts=v_local, faces=f, fil=fil, colour=_validate_hex(colour),
                             size=v.max(axis=0) - v.min(axis=0)))

    n_filaments = max(p["fil"] for p in prepared)
    filament_colour = ["#FFFFFF"] * n_filaments
    for p in prepared:
        filament_colour[p["fil"] - 1] = p["colour"]

    # ---- placement -----------------------------------------------------------------------
    if positions is not None:
        pos = [tuple(map(float, xy)) for xy in positions]
        if len(pos) != len(prepared):
            raise ValueError("positions length mismatch")
    elif auto_arrange:
        # simple shelf packer along +X then +Y, starting from the bed corner
        pos, x, y, row_h = [], spacing, spacing, 0.0
        for p in prepared:
            w, d = p["size"][0], p["size"][1]
            if x + w + spacing > bed_size[0] and x > spacing:
                x, y, row_h = spacing, y + row_h + spacing, 0.0
            pos.append((x + w / 2.0, y + d / 2.0))
            x += w + spacing
            row_h = max(row_h, d)
    else:
        pos = [(bed_size[0] / 2.0, bed_size[1] / 2.0)] * len(prepared)

    # ---- id numbering exactly as _add_model_file_to_archive ----------------------------------
    # object_id counter starts at 1; per ModelObject: volume ids = object_id.., then the
    # ModelObject's own id is the next value, then object_id += 1.
    object_id = 1
    for k, p in enumerate(prepared, 1):
        p["backup_id"] = k                     # Model::get_object_backup_id -> used in file name + UUIDs
        p["volume_id"] = object_id             # single volume
        object_id += 1
        p["object_id"] = object_id
        object_id += 1
        p["sub_path"] = "/" + (OBJECT_FILE_FMT % k)
        x, y = pos[k - 1]
        p["item_T"] = np.eye(4)
        p["item_T"][:3, 3] = [x, y, p["size"][2] / 2.0]   # min z of the centred mesh is -h/2
        p["identify_id"] = 100 + k                         # any positive int; Bambu writes the instance ObjectID

    # ---- 3D/3dmodel.model ----------------------------------------------------------------
    today = _dt.date.today().isoformat()
    meta = {
        "Application": application,
        BBS_3MF_VERSION_KEY: str(VERSION_BBS_3MF),
        "Copyright": "", "CreationDate": today, "Description": "", "Designer": "",
        "DesignerCover": "", "DesignerUserId": "", "License": "", "ModificationDate": today,
        "Origin": "", "Title": title,
    }
    if thumbnails:
        meta["Thumbnail_Middle"] = "/" + THUMBNAIL_FILE
        meta["Thumbnail_Small"] = "/" + THUMBNAIL_SMALL_FILE
    model = [_model_header(production_ext)]
    for k in sorted(meta):                                  # std::map => sorted keys
        model.append(' <metadata name="%s">%s</metadata>\n' % (k, _xml_escape(meta[k])))
    model.append(" <resources>\n")
    object_files: dict[str, str] = {}
    for p in prepared:
        if production_ext:
            # per-object file with the mesh object
            sub = [_model_header(True), ' <metadata name="%s">%s</metadata>\n' % (BBS_3MF_VERSION_KEY, VERSION_BBS_3MF),
                   " <resources>\n",
                   _mesh_object_xml(p["volume_id"], _hex8(0 + (p["backup_id"] << 16)), p["verts"], p["faces"]),
                   " </resources>\n <build/>\n</model>\n"]
            object_files[p["sub_path"].lstrip("/")] = "".join(sub)
            # component holder in the main model
            model.append('  <object id="%d" p:UUID="%s%s" type="model">\n   <components>\n'
                         % (p["object_id"], _hex8(p["backup_id"]), OBJECT_UUID_SUFFIX))
            model.append('    <component p:path="%s" objectid="%d" p:UUID="%s%s" transform="%s"/>\n'
                         % (_xml_escape(p["sub_path"]), p["volume_id"], _hex8(0 + (p["backup_id"] << 16)),
                            COMPONENT_UUID_SUFFIX, _transform_3mf(np.eye(4))))
            model.append("   </components>\n  </object>\n")
        else:
            model.append(_mesh_object_xml(p["volume_id"], None, p["verts"], p["faces"]))
            model.append('  <object id="%d" type="model">\n   <components>\n' % p["object_id"])
            model.append('    <component objectid="%d" transform="%s"/>\n' % (p["volume_id"], _transform_3mf(np.eye(4))))
            model.append("   </components>\n  </object>\n")
    model.append(" </resources>\n")
    model.append(" <build" + (' p:UUID="%s"' % BUILD_UUID if production_ext else "") + ">\n")
    for p in prepared:
        model.append('  <item objectid="%d"' % p["object_id"])
        if production_ext:
            model.append(' p:UUID="%s%s"' % (_hex8(p["object_id"]), BUILD_UUID_SUFFIX))
        model.append(' transform="%s" printable="1"/>\n' % _transform_3mf(p["item_T"]))
    model.append(" </build>\n</model>\n")
    model_xml = "".join(model)

    # ---- Metadata/model_settings.config ----------------------------------------------------
    ms = ['<?xml version="1.0" encoding="UTF-8"?>\n<config>\n']
    for p in prepared:
        ms.append('  <object id="%d">\n' % p["object_id"])
        ms.append('    <metadata key="name" value="%s"/>\n' % _xml_escape(p["name"], {'"': "&quot;"}))
        ms.append('    <metadata key="extruder" value="%d"/>\n' % p["fil"])
        ms.append('    <metadata face_count="%d"/>\n' % len(p["faces"]))
        ms.append('    <part id="%d" subtype="normal_part">\n' % p["volume_id"])
        ms.append('      <metadata key="name" value="%s"/>\n' % _xml_escape(p["name"], {'"': "&quot;"}))
        ms.append('      <metadata key="matrix" value="%s"/>\n' % _matrix_16(np.eye(4)))
        if source_file:
            ms.append('      <metadata key="source_file" value="%s"/>\n' % _xml_escape(source_file, {'"': "&quot;"}))
            ms.append('      <metadata key="source_object_id" value="%d"/>\n' % (p["backup_id"] - 1))
            ms.append('      <metadata key="source_volume_id" value="0"/>\n')
            for ax in "xyz":
                ms.append('      <metadata key="source_offset_%s" value="0"/>\n' % ax)
        ms.append('      <mesh_stat face_count="%d" edges_fixed="0" degenerate_facets="0" facets_removed="0" '
                  'facets_reversed="0" backwards_edges="0"/>\n' % len(p["faces"]))
        ms.append("    </part>\n  </object>\n")
    ms.append("  <plate>\n")
    ms.append('    <metadata key="plater_id" value="1"/>\n')
    ms.append('    <metadata key="plater_name" value="%s"/>\n' % _xml_escape(plate_name, {'"': "&quot;"}))
    ms.append('    <metadata key="locked" value="false"/>\n')
    if thumbnails:
        ms.append('    <metadata key="thumbnail_file" value="%s"/>\n' % THUMBNAIL_FILE)
    for p in prepared:
        ms.append("    <model_instance>\n")
        ms.append('      <metadata key="object_id" value="%d"/>\n' % p["object_id"])
        ms.append('      <metadata key="instance_id" value="0"/>\n')
        ms.append('      <metadata key="identify_id" value="%d"/>\n' % p["identify_id"])
        ms.append("    </model_instance>\n")
    ms.append("  </plate>\n  <assemble>\n")
    for p in prepared:
        ms.append('   <assemble_item object_id="%d" instance_id="0" transform="%s" offset="0 0 0" />\n'
                  % (p["object_id"], _transform_3mf(p["item_T"])))
    ms.append("  </assemble>\n</config>\n")
    model_settings_xml = "".join(ms)

    # ---- Metadata/project_settings.config (ConfigBase::save_to_json; every value is a string) ----
    ps: dict = {
        "version": application.split("-", 1)[-1] if "-" in application else "02.00.02.01",
        "name": "project_settings",
        "from": "project",
        "filament_colour": filament_colour,
        "filament_settings_id": [filament_settings_id] * n_filaments,
        "filament_type": [filament_type] * n_filaments,
        "curr_bed_type": bed_type,
        "printable_area": ["0x0", "%gx0" % bed_size[0], "%gx%g" % bed_size, "0x%g" % bed_size[1]],
    }
    if printer_settings_id:
        ps["printer_settings_id"] = printer_settings_id
    if printer_model:
        ps["printer_model"] = printer_model
    if print_settings_id:
        ps["print_settings_id"] = print_settings_id
    if project_settings_extra:
        ps.update(project_settings_extra)
    project_settings_json = json.dumps(ps, indent=4) + "\n"

    # ---- Metadata/slice_info.config (unsliced: header only, as in the real export) -----------
    ver = ps["version"]
    slice_info_xml = ('<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n'
                      '    <header_item key="X-BBL-Client-Type" value="slicer"/>\n'
                      '    <header_item key="X-BBL-Client-Version" value="%s"/>\n'
                      '  </header>\n</config>\n' % ver)

    # ---- Metadata/cut_information.xml ---------------------------------------------------------
    cut = ['<?xml version="1.0" encoding="utf-8"?>\n<objects>\n']
    for p in prepared:
        cut.append(' <object id="%d">\n  <cut_id id="0" check_sum="1" connectors_cnt="0"/>\n </object>\n' % p["backup_id"])
    cut.append("</objects>")
    cut_xml = "".join(cut)

    # ---- thumbnails ---------------------------------------------------------------------------
    png_big = png_small = None
    if thumbnails:
        placed = [((p["verts"] @ p["item_T"][:3, :3].T) + p["item_T"][:3, 3], p["faces"], p["colour"]) for p in prepared]
        png_big = _render_top_view(placed, bed_size, thumbnail_size)
        png_small = _render_top_view(placed, bed_size, max(32, thumbnail_size // 4))

    # ---- assemble the zip in BambuStudio's order ---------------------------------------------
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr(CONTENT_TYPES_FILE, _content_types_xml())
        if thumbnails:
            z.writestr(THUMBNAIL_FILE, png_big)
            z.writestr(THUMBNAIL_SMALL_FILE, png_small)
        z.writestr(MODEL_FILE, model_xml)
        if production_ext:
            z.writestr(MODEL_RELS_FILE, _rels_xml([n for n in object_files], REL_3DMODEL))
            for n, data in object_files.items():
                z.writestr(n, data)
        z.writestr(BBS_PROJECT_CONFIG_FILE, project_settings_json)
        z.writestr(BBS_MODEL_CONFIG_FILE, model_settings_xml)
        z.writestr(CUT_INFORMATION_FILE, cut_xml)
        z.writestr(SLICE_INFO_CONFIG_FILE, slice_info_xml)
        z.writestr(RELATIONSHIPS_FILE, _root_rels_xml(thumbnails))

    return {
        "path": path,
        "layout": layout,
        "objects": [{"name": p["name"], "object_id": p["object_id"], "volume_id": p["volume_id"],
                     "file": p["sub_path"].lstrip("/") if production_ext else MODEL_FILE,
                     "extruder": p["fil"], "colour": p["colour"], "faces": int(len(p["faces"])),
                     "position": [float(v) for v in p["item_T"][:3, 3]]} for p in prepared],
        "filament_colour": filament_colour,
    }


# ----------------------------------------------------------------------------
# Small independent reader (for validation / round trip)
# ----------------------------------------------------------------------------
def read_bambu_3mf_summary(path: str) -> dict:
    import xml.etree.ElementTree as ET
    out: dict = {"entries": [], "objects": [], "plate_instances": [], "filament_colour": None}
    with zipfile.ZipFile(path) as z:
        out["entries"] = z.namelist()
        ns = {"m": NS_CORE, "p": NS_PROD}
        root = ET.fromstring(z.read(MODEL_FILE))
        # objects defined in main model
        meshes = {}
        for obj in root.iter("{%s}object" % NS_CORE):
            oid = int(obj.get("id"))
            mesh = obj.find("m:mesh", ns)
            if mesh is not None:
                meshes[(MODEL_FILE, oid)] = (len(mesh.findall("m:vertices/m:vertex", ns)),
                                             len(mesh.findall("m:triangles/m:triangle", ns)))
        # objects in sub-files
        for n in z.namelist():
            if n.startswith("3D/Objects/") and n.endswith(".model"):
                sub = ET.fromstring(z.read(n))
                for obj in sub.iter("{%s}object" % NS_CORE):
                    mesh = obj.find("m:mesh", ns)
                    if mesh is not None:
                        meshes[(n, int(obj.get("id")))] = (len(mesh.findall("m:vertices/m:vertex", ns)),
                                                           len(mesh.findall("m:triangles/m:triangle", ns)))
        settings = ET.fromstring(z.read(BBS_MODEL_CONFIG_FILE)) if BBS_MODEL_CONFIG_FILE in z.namelist() else None
        extr, names = {}, {}
        if settings is not None:
            for o in settings.findall("object"):
                oid = int(o.get("id"))
                for md in o.findall("metadata"):
                    if md.get("key") == "extruder":
                        extr[oid] = int(md.get("value"))
                    if md.get("key") == "name":
                        names[oid] = md.get("value")
            for pl in settings.findall("plate"):
                for inst in pl.findall("model_instance"):
                    d = {md.get("key"): md.get("value") for md in inst.findall("metadata")}
                    out["plate_instances"].append(d)
        for item in root.findall("m:build/m:item", ns):
            oid = int(item.get("objectid"))
            holder = root.find("m:resources/m:object[@id='%d']" % oid, ns)
            comps = []
            if holder is not None:
                for c in holder.findall("m:components/m:component", ns):
                    cpath = c.get("{%s}path" % NS_PROD, MODEL_FILE).lstrip("/")
                    comps.append((cpath, int(c.get("objectid")), meshes.get((cpath, int(c.get("objectid"))))))
            out["objects"].append({"object_id": oid, "name": names.get(oid), "extruder": extr.get(oid),
                                   "transform": item.get("transform"), "components": comps})
        if BBS_PROJECT_CONFIG_FILE in z.namelist():
            js = json.loads(z.read(BBS_PROJECT_CONFIG_FILE))
            out["filament_colour"] = js.get("filament_colour")
    return out


# ----------------------------------------------------------------------------
# Sample
# ----------------------------------------------------------------------------
def make_sample_objects():
    import trimesh as tm
    cube = tm.creation.box(extents=(20, 20, 20))
    sphere = tm.creation.icosphere(subdivisions=2, radius=10)
    cyl = tm.creation.cylinder(radius=8, height=25, sections=48)
    # wedge: right triangular prism, 30 x 20 footprint, 15 tall
    wv = np.array([[0, 0, 0], [30, 0, 0], [30, 20, 0], [0, 20, 0],
                   [0, 0, 15], [0, 20, 15]], dtype=float)
    wf = np.array([[0, 2, 1], [0, 3, 2],            # bottom
                   [0, 1, 4],                       # front (y=0) triangle
                   [3, 5, 2],                       # back (y=20) triangle
                   [0, 4, 5], [0, 5, 3],            # left wall x=0
                   [1, 2, 5], [1, 5, 4]])           # slope
    wedge = tm.Trimesh(wv, wf, process=False)   # winding is already outward (checked by hand)
    return [("Cube", cube, 1, "#FF0000"),
            ("Sphere", sphere, 2, "#00A000"),
            ("Cylinder", cyl, 3, "#0040FF"),
            ("Wedge", wedge, 4, "#FFD700")]


if __name__ == "__main__":
    import sys
    out = sys.argv[1] if len(sys.argv) > 1 else "sample_bambu.3mf"
    layout = sys.argv[2] if len(sys.argv) > 2 else "split"
    info = write_bambu_3mf(out, make_sample_objects(), layout=layout, title="bambu3mf sample")
    print(json.dumps(info, indent=2))
