#!/usr/bin/env python3
"""
Eagle kit generator: a 1.0 m wingspan soaring eagle, split for a 256 mm bed,
multi-colour, with filament-pin feather joints and dowel body joints.

Outputs (in --out, default kits/eagle/out):
  stl/<part>.stl             one binary STL per part, oriented for printing
  eagle_kit_bambu.3mf        Bambu Studio project, one object per part, filament per part
  eagle_assembled.glb        assembled, coloured scene for viewing
  preview.png                assembled + exploded render
  parts.csv                  part list: colour, bbox, volume, estimated grams

Usage:
  python3 eagle_kit.py [--colourway bald|fish] [--span 1000] [--out DIR]

Geometry is procedural (lofts and extruded 2D outlines); it is a printable
engineering base, not a hand-sculpted model. Axes: X = span, Y = forward, Z = up. Units mm.
"""
from __future__ import annotations

import argparse
import csv
import math
import os
import sys

import numpy as np
import shapely
import shapely.affinity as aff
import trimesh
from shapely.geometry import Polygon, Point, LineString
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
try:
    from bambu3mf import write_bambu_3mf, read_bambu_3mf_summary
except Exception:  # writer is optional
    write_bambu_3mf = None
    read_bambu_3mf_summary = None

# ----------------------------------------------------------------------------- parameters
BED = 250.0                     # usable bed (256 nominal, keep margin)
PLATE_T = 3.0                   # feather / covert / tail thickness
SPAR_T = 6.0                    # wing spar thickness
SPAR_W = 22.0
PIN_D = 1.9                     # holes for 1.75 mm filament pins
DOWEL_D = 6.0                   # printed dowels for body joints
DOWEL_CLR = 0.4                 # diametral clearance for dowels
DOWEL_L = 30.0
COLUMN_D = 14.0                 # stand column
RING_N = 36                     # loft resolution

COLOURWAYS = {
    # filament slot 1..4 -> hex ; roles map to slots
    "bald": {
        "name": "Bald eagle",
        "slots": ["#3A2718", "#F4F1EA", "#F0B323", "#161616"],  # brown, white, yellow, black
        "roles": {"body": 1, "wing": 1, "covert": 1, "head": 2, "tail": 2, "beak": 3, "feet": 3,
                  "eye": 4, "stand": 4, "dowel": 1},
    },
    "fish": {
        "name": "African fish eagle",
        "slots": ["#6B2F14", "#F4F1EA", "#1C1C1C", "#E8B126"],  # chestnut, white, black, yellow
        "roles": {"body": 1, "wing": 3, "covert": 1, "head": 2, "tail": 2, "beak": 4, "feet": 4,
                  "eye": 3, "stand": 3, "dowel": 1},
    },
}


# ----------------------------------------------------------------------------- mesh helpers
def loft(stations, n=RING_N):
    """stations: list of (y, half_w, half_h, z_center[, shape]) ellipse rings along +Y.
    Returns a watertight trimesh with fan caps."""
    t = np.linspace(0, 2 * math.pi, n, endpoint=False)
    rings = []
    for st in stations:
        y, w, h, zc = st[:4]
        p = st[4] if len(st) > 4 else 2.0  # superellipse exponent (2 = ellipse)
        c, s = np.cos(t), np.sin(t)
        x = w * np.sign(c) * np.abs(c) ** (2.0 / p)
        z = zc + h * np.sign(s) * np.abs(s) ** (2.0 / p)
        rings.append(np.column_stack([x, np.full(n, float(y)), z]))
    verts = np.vstack(rings)
    faces = []
    m = len(rings)
    for i in range(m - 1):
        a, b = i * n, (i + 1) * n
        for j in range(n):
            k = (j + 1) % n
            faces.append([a + j, b + j, b + k])
            faces.append([a + j, b + k, a + k])
    c0 = len(verts)
    verts = np.vstack([verts, rings[0].mean(axis=0, keepdims=True), rings[-1].mean(axis=0, keepdims=True)])
    c1 = c0 + 1
    for j in range(n):
        k = (j + 1) % n
        faces.append([c0, k, j])                      # start cap
        faces.append([c1, (m - 1) * n + j, (m - 1) * n + k])  # end cap
    mesh = trimesh.Trimesh(verts, np.array(faces), process=True)
    mesh.fix_normals()
    if mesh.volume < 0:
        mesh.invert()
    return mesh


def extrude(poly: Polygon, height: float, z0: float = 0.0) -> trimesh.Trimesh:
    m = trimesh.creation.extrude_polygon(poly, height)
    m.apply_translation([0, 0, z0])
    return m


def cyl(d, h, center=(0, 0, 0), direction=(0, 0, 1)):
    m = trimesh.creation.cylinder(radius=d / 2.0, height=h, sections=48)
    direction = np.asarray(direction, dtype=float)
    direction /= np.linalg.norm(direction)
    R = trimesh.geometry.align_vectors([0, 0, 1], direction)
    m.apply_transform(R)
    m.apply_translation(center)
    return m


def box(size, center=(0, 0, 0), transform=None):
    m = trimesh.creation.box(extents=size)
    if transform is not None:
        m.apply_transform(transform)
    m.apply_translation(center)
    return m


def diff(a, cutters):
    return trimesh.boolean.difference([a] + list(cutters), engine="manifold")


def union(parts):
    return trimesh.boolean.union(list(parts), engine="manifold")


def rot(axis, deg, point=(0, 0, 0)):
    return trimesh.transformations.rotation_matrix(math.radians(deg), axis, point)


def feather_outline(length, width, tip_round=0.55, asym=0.35, notch=0.0):
    """2D feather vane with root at origin, pointing +Y. asym shifts the rachis toward -X."""
    n = 28
    pts = []
    # outer (leading) edge, narrower side
    for i in range(n + 1):
        s = i / n
        y = length * s
        half = width * (0.25 + 0.75 * math.sin(math.pi * min(1.0, s / 0.92)) ** 0.6)
        if s > 0.92:
            half *= (1 - ((s - 0.92) / 0.08) ** 2 * tip_round)
        pts.append((-half * (1 - asym), y))
    for i in range(n, -1, -1):
        s = i / n
        y = length * s
        half = width * (0.25 + 0.75 * math.sin(math.pi * min(1.0, s / 0.92)) ** 0.6)
        if s > 0.92:
            half *= (1 - ((s - 0.92) / 0.08) ** 2 * tip_round)
        x = half * (1 + asym)
        if notch > 0 and 0.62 < s < 0.86:  # emarginated outer web (primaries)
            x *= 1 - notch * math.sin(math.pi * (s - 0.62) / 0.24)
        pts.append((x, y))
    poly = Polygon(pts).buffer(0)
    # root tab, 24 x 20, centred on the rachis
    tab = Polygon([(-12, -2), (12, -2), (12, 20), (-12, 20)])
    return unary_union([poly, tab]).buffer(0)


def with_pin_holes(poly, holes):
    for (x, y) in holes:
        poly = poly.difference(Point(x, y).buffer(PIN_D / 2.0, resolution=12))
    return poly


# ----------------------------------------------------------------------------- the eagle
class Kit:
    def __init__(self, colourway="bald", span=1000.0):
        self.cw = COLOURWAYS[colourway]
        self.scale = span / 1000.0
        self.parts = []   # (name, mesh_assembled, mesh_print, role)
        self.exploded = {}

    def add(self, name, assembled, role, print_mesh=None, explode=(0, 0, 0)):
        if not assembled.is_watertight:
            assembled.fill_holes()
        if assembled.volume < 0:
            assembled.invert()
        self.parts.append((name, assembled, print_mesh if print_mesh is not None else assembled, role))
        self.exploded[name] = np.asarray(explode, dtype=float)

    # ---- body, head, beak
    def build_body(self):
        s = self.scale
        rear = [(-150, 14, 12, 4, 2.4), (-120, 26, 22, 2), (-80, 40, 35, 2), (-40, 50, 44, 3), (0, 54, 48, 5)]
        front = [(0, 54, 48, 5), (40, 53, 47, 7), (80, 48, 43, 10), (115, 40, 36, 14), (140, 30, 28, 18)]
        head = [(140, 30, 28, 18), (160, 34, 31, 24), (180, 37, 34, 29), (205, 35, 32, 31), (228, 26, 24, 29), (240, 16, 15, 26)]
        beak = [(236, 11, 11, 25), (252, 10, 9.5, 22), (264, 8, 7, 16), (272, 5, 4, 8), (276, 2.5, 2, 2)]
        scl = lambda st: [(a * s, b * s, c * s, d * s) + tuple(e[4:]) for e in [st] for a, b, c, d in [st[:4]]]
        S = lambda stations: [tuple(v * s for v in st[:4]) + tuple(st[4:]) for st in stations]

        rear_m = loft(S(rear))
        front_m = loft(S(front))
        head_m = loft(S(head))
        beak_m = loft(S(beak))

        # dowel sockets: body split at y=0 (two dowels), neck at y=140 (two dowels)
        dd = DOWEL_D + DOWEL_CLR
        socks_rear = [cyl(dd, DOWEL_L + 2, (x * s, 0, 5 * s + z * s), (0, 1, 0)) for x, z in [(-22, 8), (22, 8)]]
        socks_front = [cyl(dd, DOWEL_L + 2, (x * s, 0, 5 * s + z * s), (0, 1, 0)) for x, z in [(-22, 8), (22, 8)]]
        socks_neck_f = [cyl(dd, DOWEL_L + 2, (x * s, 140 * s, 18 * s + z * s), (0, 1, 0)) for x, z in [(-12, 0), (12, 0)]]
        socks_neck_h = socks_neck_f
        # wing pockets (front body): rectangular pocket for the spar root tab, with dihedral
        pockets = []
        for sign in (1, -1):
            T = rot([0, 1, 0], -sign * self.dihedral) @ rot([0, 0, 1], 0)
            p = box((50 * s, SPAR_W + 0.6, SPAR_T + 0.6), transform=T, center=(sign * 40 * s, 40 * s, 30 * s))
            pockets.append(p)
        # stand socket in belly (front body, under wing root)
        stand_sock = cyl(COLUMN_D + 0.5, 28, (0, 20 * s, -48 * s + 12), (0, 0, 1))
        # tail pocket (rear body): flat slot for the tail root tabs
        tail_pocket = box((70 * s, 50, PLATE_T * 2 + 0.6), center=(0, -135 * s, 6 * s))
        # feet sockets (rear body underside)
        feet_socks = [cyl(dd, 20, (sign * 16 * s, -60 * s, -40 * s + 6), (0, 0, 1)) for sign in (1, -1)]
        # eye recesses (head)
        eye_rec = [cyl(8.4, 6, (sign * 34 * s, 192 * s, 36 * s), (sign, 0, 0)) for sign in (1, -1)]

        rear_m = diff(rear_m, socks_rear + [tail_pocket] + feet_socks)
        front_m = diff(front_m, socks_front + socks_neck_f + pockets + [stand_sock])
        head_m = diff(head_m, socks_neck_h + eye_rec)
        # beak joins head with a small 4 mm dowel-free press fit: give head a socket and beak a peg
        peg = cyl(5.0, 16, (0, 236 * s, 25 * s), (0, 1, 0))
        head_m = diff(head_m, [cyl(5.5, 14, (0, 238 * s, 25 * s), (0, 1, 0))])
        beak_m = union([beak_m, peg])

        # print orientation: body halves on their cut faces, head on neck cut, beak on its root
        self.add("body_rear", rear_m, "body", self.orient(rear_m, rot([1, 0, 0], 90)), explode=(0, -60, 0))
        self.add("body_front", front_m, "body", self.orient(front_m, rot([1, 0, 0], -90)), explode=(0, 0, 0))
        self.add("head", head_m, "head", self.orient(head_m, rot([1, 0, 0], -90)), explode=(0, 60, 20))
        self.add("beak", beak_m, "beak", self.orient(beak_m, rot([1, 0, 0], -90)), explode=(0, 110, 20))
        for sign, nm in ((1, "eye_R"), (-1, "eye_L")):
            e = cyl(8.0, 2.6, (sign * (34 * s + 1.5), 192 * s, 36 * s), (sign, 0, 0))
            self.add(nm, e, "eye", self.orient(e, rot([0, 1, 0], -sign * 90)), explode=(sign * 40, 60, 20))
        for sign, nm in ((1, "foot_R"), (-1, "foot_L")):
            f = trimesh.creation.icosphere(subdivisions=3, radius=1.0)
            f.apply_scale([11 * s, 20 * s, 8 * s])
            f.apply_translation([sign * 16 * s, -62 * s, -46 * s])
            f = union([f, cyl(DOWEL_D, 18, (sign * 16 * s, -60 * s, -40 * s), (0, 0, 1))])
            self.add(nm, f, "feet", self.orient(f, rot([1, 0, 0], 180)), explode=(sign * 20, -60, -50))
        for i, (x, z, y) in enumerate([(-22, 8, 0), (22, 8, 0), (-12, 0, 140), (12, 0, 140)]):
            d = cyl(DOWEL_D, DOWEL_L, (x * s, y * s, (5 if y == 0 else 18) * s + z * s), (0, 1, 0))
            self.add(f"dowel_{i+1}", d, "dowel", self.orient(d, rot([1, 0, 0], 90)), explode=(0, -30 if y == 0 else 30, 40))

    # ---- wings
    dihedral = 8.0

    def build_wing(self, sign):
        s = self.scale
        side = "R" if sign > 0 else "L"
        root_x, tip_x = 35 * s, 440 * s
        spar_y = lambda x: 40 * s - 55 * s * ((x - root_x) / (tip_x - root_x)) ** 1.6  # gentle sweep back
        split_x = root_x + (tip_x - root_x) * 0.5

        def spar_segment(x0, x1, tab_root=False):
            pts = [(x, spar_y(x)) for x in np.linspace(x0, x1, 12)]
            line = LineString(pts)
            poly = line.buffer(SPAR_W / 2.0, cap_style="flat")
            if tab_root:  # straight root tab that enters the body pocket
                tab = Polygon([(x0 - 20 * s, spar_y(x0) - SPAR_W / 2), (x0 + 1, spar_y(x0) - SPAR_W / 2),
                               (x0 + 1, spar_y(x0) + SPAR_W / 2), (x0 - 20 * s, spar_y(x0) + SPAR_W / 2)])
                poly = unary_union([poly, tab])
            return poly

        inner = spar_segment(root_x, split_x + 2, tab_root=True)
        outer = spar_segment(split_x - 2, tip_x)
        # feathers along the spar: 10 secondaries (inner) + 8 primaries (outer)
        n_sec, n_pri = 10, 8
        feathers = []
        xs = np.linspace(root_x + 15 * s, tip_x - 12 * s, n_sec + n_pri)
        holes_by_seg = {"inner": [], "outer": []}
        for i, x in enumerate(xs):
            u = i / (len(xs) - 1)
            is_pri = i >= n_sec
            if not is_pri:
                length = (180 + 25 * math.sin(math.pi * u / 0.55)) * s
                width = 58 * s
                angle = -8 - 14 * u           # degrees from -Y, toward +X (outward)
                notch = 0.0
            else:
                k = (i - n_sec) / (n_pri - 1)
                length = (235 - 60 * k ** 1.8) * s
                width = (52 - 10 * k) * s
                angle = -22 - 52 * k
                notch = 0.18 + 0.1 * k
            length = min(length, BED - 20)
            outline = feather_outline(length, width, asym=0.3, notch=notch)
            holes = [(-6, 6), (6, 6), (0, 15)]
            outline = with_pin_holes(outline, holes)
            # local: root at origin pointing +Y. Rotate so vane points backward (-Y) and outward.
            ang = 180 + (-angle if sign > 0 else angle)
            yx = spar_y(x)
            placed = aff.rotate(outline, ang, origin=(0, 0))
            placed = aff.translate(placed, x, yx)
            seg = "inner" if x < split_x else "outer"
            for hx, hy in holes:
                p = aff.translate(aff.rotate(Point(hx, hy), ang, origin=(0, 0)), x, yx)
                holes_by_seg[seg].append((p.x, p.y))
            nm = f"wing_{side}_{'p' if is_pri else 's'}{(i - n_sec + 1) if is_pri else (i + 1):02d}"
            feathers.append((nm, placed, i))

        # covert plates: hide tabs; scalloped trailing edge, pinned through same holes
        def covert(x0, x1):
            top = [(x, spar_y(x) + SPAR_W / 2 + 6 * s) for x in np.linspace(x0, x1, 10)]
            bot = []
            for x in np.linspace(x1, x0, 40):
                sc = 70 * s + 8 * s * math.sin((x / (18 * s)) * math.pi)  # scallops
                bot.append((x, spar_y(x) - sc))
            return Polygon(top + bot).buffer(0)

        cov_in = covert(root_x + 2, split_x + 2)
        cov_out = covert(split_x - 2, tip_x - 10 * s)
        for seg, poly in (("inner", inner), ("outer", outer)):
            holes_by_seg[seg] = [(hx, hy) for hx, hy in holes_by_seg[seg] if poly.buffer(1).contains(Point(hx, hy))]
        inner = with_pin_holes(inner, holes_by_seg["inner"])
        outer = with_pin_holes(outer, holes_by_seg["outer"])
        cov_in = with_pin_holes(cov_in, [h for h in holes_by_seg["inner"] if cov_in.contains(Point(*h))])
        cov_out = with_pin_holes(cov_out, [h for h in holes_by_seg["outer"] if cov_out.contains(Point(*h))])
        # splice plate joining the two spar segments (pinned, 4 holes)
        sp_pts = [(x, spar_y(x)) for x in np.linspace(split_x - 35, split_x + 35, 8)]
        splice = LineString(sp_pts).buffer(SPAR_W / 2.0 - 1, cap_style="flat")
        sp_holes = [(split_x + dx, spar_y(split_x + dx) + dy) for dx in (-24, 24) for dy in (-5, 5)]
        splice = with_pin_holes(splice, sp_holes)
        inner = with_pin_holes(inner, [h for h in sp_holes if h[0] <= split_x + 2])
        outer = with_pin_holes(outer, [h for h in sp_holes if h[0] >= split_x - 2])

        # assemble in 3D: spar at z=30 (shoulder), feathers below the spar, coverts above
        T = rot([0, 1, 0], -sign * self.dihedral, point=(0, 0, 30 * s))
        mirror = np.diag([-1, 1, 1, 1]) if sign < 0 else np.eye(4)

        def place(mesh, z):
            mesh.apply_translation([0, 0, z])
            mesh.apply_transform(mirror)
            mesh.apply_transform(T)
            return mesh

        z_spar = 30 * s
        ex = (sign * 120, 0, 0)
        self.add(f"wing_{side}_spar_inner", place(extrude(inner, SPAR_T), z_spar), "wing",
                 extrude(inner, SPAR_T), explode=ex)
        self.add(f"wing_{side}_spar_outer", place(extrude(outer, SPAR_T), z_spar), "wing",
                 extrude(outer, SPAR_T), explode=(sign * 220, 0, 0))
        self.add(f"wing_{side}_splice", place(extrude(splice, PLATE_T), z_spar + SPAR_T), "wing",
                 extrude(splice, PLATE_T), explode=(sign * 170, 0, 40))
        self.add(f"wing_{side}_covert_inner", place(extrude(cov_in, PLATE_T), z_spar + SPAR_T + 0.2), "covert",
                 extrude(cov_in, PLATE_T), explode=(sign * 120, 0, 60))
        self.add(f"wing_{side}_covert_outer", place(extrude(cov_out, PLATE_T), z_spar + SPAR_T + 0.2), "covert",
                 extrude(cov_out, PLATE_T), explode=(sign * 220, 0, 60))
        for nm, poly, i in feathers:
            # feathers under the spar, each 0.35 mm lower than the previous so overlaps read in renders
            z = z_spar - PLATE_T - 0.35 * i
            self.add(nm, place(extrude(poly, PLATE_T), z), "wing", extrude(poly, PLATE_T),
                     explode=(sign * (120 + 100 * (i >= n_sec)), -40, -30))

    # ---- tail
    def build_tail(self):
        s = self.scale
        for sign, side in ((1, "R"), (-1, "L")):
            outlines = []
            for j in range(6):
                k = j / 5.0
                length = (150 - 18 * k ** 2) * s
                o = feather_outline(length, 36 * s, asym=0.25)
                o = aff.rotate(o, 180 + sign * (6 + 56 * k), origin=(0, 0))
                o = aff.translate(o, sign * (4 + 9 * j) * s, 0)
                outlines.append(o)
            fan = unary_union(outlines).buffer(0.01).buffer(-0.01)
            tab = Polygon([(0, -2), (sign * 32 * s, -2), (sign * 32 * s, 42), (0, 42)])
            fan = unary_union([fan, tab]).buffer(0)
            fan = aff.translate(fan, 0, -115 * s)  # root tab sits in the rear body pocket
            m = extrude(fan, PLATE_T)
            m.apply_translation([0, 0, 6 * s - PLATE_T if sign > 0 else 6 * s])
            self.add(f"tail_{side}", m, "tail", extrude(fan, PLATE_T), explode=(sign * 30, -120, 0))

    # ---- stand
    def build_stand(self):
        s = self.scale
        base = cyl(180, 8, (0, 20 * s, -48 * s - 230 - 4), (0, 0, 1))
        base = diff(base, [cyl(COLUMN_D + 0.5, 14, (0, 20 * s, -48 * s - 230 - 1), (0, 0, 1))])
        col = cyl(COLUMN_D, 246, (0, 20 * s, -48 * s - 230 + 123 - 10), (0, 0, 1))
        self.add("stand_base", base, "stand", self.orient(base, np.eye(4)), explode=(0, 0, -80))
        self.add("stand_column", col, "stand", self.orient(col, np.eye(4)), explode=(0, 0, -40))

    @staticmethod
    def orient(mesh, transform):
        m = mesh.copy()
        m.apply_transform(transform)
        m.apply_translation(-m.bounds[0])
        return m

    def build(self):
        self.build_body()
        self.build_wing(+1)
        self.build_wing(-1)
        self.build_tail()
        self.build_stand()
        return self

    # ---- exports
    def colour_of(self, role):
        return self.cw["slots"][self.cw["roles"][role] - 1]

    def export(self, out):
        os.makedirs(os.path.join(out, "stl"), exist_ok=True)
        rows = []
        scene = trimesh.Scene()
        exploded = trimesh.Scene()
        total_g = 0.0
        too_big = []
        for name, asm, prt, role in self.parts:
            prt = prt.copy()
            prt.apply_translation(-prt.bounds[0])
            prt.export(os.path.join(out, "stl", f"{name}.stl"))
            ext = prt.extents
            vol_cm3 = abs(prt.volume) / 1000.0
            fill = 0.85 if min(ext) <= 4.0 else 0.35   # thin plates print nearly solid; bodies: shells + 15 % infill
            grams = vol_cm3 * fill * 1.24     # PLA 1.24 g/cm3
            total_g += grams
            if max(ext) > BED or sorted(ext)[1] > BED:
                too_big.append(name)
            rows.append([name, role, self.cw["roles"][role], self.colour_of(role),
                         f"{ext[0]:.1f}", f"{ext[1]:.1f}", f"{ext[2]:.1f}", f"{vol_cm3:.1f}", f"{grams:.0f}",
                         "yes" if prt.is_watertight else "NO"])
            col = trimesh.visual.color.hex_to_rgba(self.colour_of(role))
            a = asm.copy(); a.visual.face_colors = col
            scene.add_geometry(a, node_name=name, geom_name=name)
            e = asm.copy(); e.apply_translation(self.exploded[name] * 1.8); e.visual.face_colors = col
            exploded.add_geometry(e, node_name=name, geom_name=name)
        with open(os.path.join(out, "parts.csv"), "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["part", "role", "filament_slot", "colour", "x_mm", "y_mm", "z_mm", "volume_cm3", "est_grams", "watertight"])
            w.writerows(rows)
        scene.export(os.path.join(out, "eagle_assembled.glb"))
        exploded.export(os.path.join(out, "eagle_exploded.glb"))
        summary = {"parts": len(self.parts), "total_grams": round(total_g), "too_big": too_big,
                   "wingspan_mm": round(float(scene.bounds[1][0] - scene.bounds[0][0]), 1),
                   "length_mm": round(float(scene.bounds[1][1] - scene.bounds[0][1]), 1),
                   "height_mm": round(float(scene.bounds[1][2] - scene.bounds[0][2]), 1),
                   "not_watertight": [r[0] for r in rows if r[-1] == "NO"]}
        # grams per filament slot
        per_slot = {}
        for r in rows:
            per_slot[r[2]] = per_slot.get(r[2], 0) + float(r[8])
        summary["grams_per_slot"] = {int(k): round(v) for k, v in sorted(per_slot.items())}
        # Bambu 3MF
        if write_bambu_3mf is not None:
            objs = [(name, prt, self.cw["roles"][role], self.colour_of(role)) for name, asm, prt, role in self.parts]
            try:
                info = write_bambu_3mf(os.path.join(out, "eagle_kit_bambu.3mf"), objs, layout="split",
                                       bed_size=(256.0, 256.0), auto_arrange=True, title="Eagle kit",
                                       printer_settings_id="Bambu Lab P1S 0.4 nozzle", printer_model="Bambu Lab P1S",
                                       print_settings_id="0.20mm Standard @BBL P1P",
                                       filament_settings_id="Bambu PLA Basic @BBL P1P")
                summary["bambu_3mf"] = {k: v for k, v in info.items() if k in ("plates", "objects", "path")} if isinstance(info, dict) else str(info)
            except Exception as e:  # keep going; STLs are the fallback
                summary["bambu_3mf"] = f"failed: {e!r}"
        self.render(out, scene, exploded)
        return summary

    def render(self, out, scene, exploded):
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from mpl_toolkits.mplot3d.art3d import Poly3DCollection

        def draw(ax, sc, elev, azim, title):
            allb = sc.bounds
            for name, g in sc.geometry.items():
                g2 = g
                if len(g.faces) > 1500:
                    g2 = g.simplify_quadric_decimation(face_count=1500) if hasattr(g, "simplify_quadric_decimation") else g
                tri = g2.vertices[g2.faces]
                col = np.array(g.visual.face_colors[0][:3]) / 255.0
                pc = Poly3DCollection(tri, facecolors=col, edgecolors=col * 0.55, linewidths=0.15)
                ax.add_collection3d(pc)
            c = (allb[0] + allb[1]) / 2; r = (allb[1] - allb[0]).max() / 2 * 0.62
            ax.set_xlim(c[0] - r, c[0] + r); ax.set_ylim(c[1] - r, c[1] + r); ax.set_zlim(c[2] - r, c[2] + r)
            ax.view_init(elev=elev, azim=azim); ax.set_axis_off(); ax.set_title(title, fontsize=11)

        fig = plt.figure(figsize=(16, 10), dpi=110)
        draw(fig.add_subplot(2, 2, 1, projection="3d"), scene, 35, -60, "Assembled, 3/4 view from above")
        draw(fig.add_subplot(2, 2, 2, projection="3d"), scene, 90, -90, "Top view")
        draw(fig.add_subplot(2, 2, 3, projection="3d"), scene, 5, -90, "Front view")
        draw(fig.add_subplot(2, 2, 4, projection="3d"), exploded, 35, -60, "Exploded")
        span = scene.bounds[1][0] - scene.bounds[0][0]
        fig.suptitle(f"{self.cw['name']} kit, {span:.0f} mm wingspan, {len(self.parts)} parts", fontsize=14)
        fig.tight_layout()
        fig.savefig(os.path.join(out, "preview.png"))
        plt.close(fig)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--colourway", choices=list(COLOURWAYS), default="bald")
    ap.add_argument("--span", type=float, default=1000.0)
    ap.add_argument("--out", default=os.path.join(HERE, "out"))
    a = ap.parse_args()
    kit = Kit(a.colourway, a.span).build()
    summary = kit.export(a.out)
    import json
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
