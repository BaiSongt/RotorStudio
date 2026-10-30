"""将真实 OpenCascade 网格渲染为三联说明图；不调用浏览器，也不补绘模型几何。

依赖：numpy、Pillow。先运行 export-rotational-examples.mjs 生成临时网格。
运行：python scripts/render-rotational-preview.py --font /path/to/NotoSansCJK-Regular.ttc
使用正交投影、逐像素深度缓冲、插值法线、阴影贴图与隐藏线检测。
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
SS = 2
WIDTH, HEIGHT = 1920, 990


def unit(vector):
    vector = np.asarray(vector, dtype=np.float64)
    return vector / np.linalg.norm(vector)


def camera(vertices, direction, width, height, margin=45):
    view = unit(direction)
    vertical = [0, 1, 0] if abs(view[1]) < 0.98 else [0, 0, 1]
    right = unit(np.cross(vertical, view))
    up = np.cross(view, right)
    center = (vertices.min(axis=0) + vertices.max(axis=0)) / 2
    local = vertices - center
    plane = np.column_stack((local @ right, local @ up))
    minimum, maximum = plane.min(axis=0), plane.max(axis=0)
    scale = min((width - 2 * margin) / (maximum[0] - minimum[0]),
                (height - 2 * margin) / (maximum[1] - minimum[1]))
    return {"view": view, "right": right, "up": up, "center": center,
            "middle": (minimum + maximum) / 2, "scale": scale,
            "width": width, "height": height}


def project(points, cam):
    local = points - cam["center"]
    x = ((local @ cam["right"]) - cam["middle"][0]) * cam["scale"] + cam["width"] / 2
    y = -((local @ cam["up"]) - cam["middle"][1]) * cam["scale"] + cam["height"] / 2
    return np.column_stack((x, y, local @ cam["view"]))


def rasterize(vertices, triangles, normals, cam, with_normals=True):
    """真实三角形逐片光栅化，最近表面覆盖远处表面，包括所有孔腔遮挡。"""
    width, height = cam["width"], cam["height"]
    projected = project(vertices, cam)
    depth = np.full((height, width), -np.inf, dtype=np.float32)
    normal_buffer = np.zeros((height, width, 3), dtype=np.float32) if with_normals else None
    front = normals[triangles].mean(axis=1) @ cam["view"] > -1e-7
    for indices in triangles[front]:
        p = projected[indices]
        x0, x1 = max(0, int(np.floor(p[:, 0].min()))), min(width - 1, int(np.ceil(p[:, 0].max())))
        y0, y1 = max(0, int(np.floor(p[:, 1].min()))), min(height - 1, int(np.ceil(p[:, 1].max())))
        if x0 > x1 or y0 > y1:
            continue
        denominator = ((p[1, 1] - p[2, 1]) * (p[0, 0] - p[2, 0])
                       + (p[2, 0] - p[1, 0]) * (p[0, 1] - p[2, 1]))
        if abs(denominator) < 1e-10:
            continue
        yy, xx = np.mgrid[y0:y1 + 1, x0:x1 + 1]
        xx, yy = xx + 0.5, yy + 0.5
        a = ((p[1, 1] - p[2, 1]) * (xx - p[2, 0]) + (p[2, 0] - p[1, 0]) * (yy - p[2, 1])) / denominator
        b = ((p[2, 1] - p[0, 1]) * (xx - p[2, 0]) + (p[0, 0] - p[2, 0]) * (yy - p[2, 1])) / denominator
        c = 1 - a - b
        fragment_depth = a * p[0, 2] + b * p[1, 2] + c * p[2, 2]
        old = depth[y0:y1 + 1, x0:x1 + 1]
        covered = ((a >= -1e-8) & (b >= -1e-8) & (c >= -1e-8) & (fragment_depth > old))
        if not covered.any():
            continue
        old[covered] = fragment_depth[covered]
        if with_normals:
            n = (a[covered, None] * normals[indices[0]]
                 + b[covered, None] * normals[indices[1]]
                 + c[covered, None] * normals[indices[2]])
            n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-10)
            normal_buffer[y0:y1 + 1, x0:x1 + 1][covered] = n
    return depth, normal_buffer


def visible_edges(rgb, depth, normal_buffer, edge_lines, cam):
    """只绘制可见的 BRep 棱线；平滑圆柱参数缝不作为实体棱边显示。"""
    height, width = depth.shape
    color = np.array([0.23, 0.29, 0.33])
    for endpoints in edge_lines:
        p = project(endpoints, cam)
        delta = p[1, :2] - p[0, :2]
        length = np.linalg.norm(delta)
        if length < 0.2:
            continue
        steps = max(2, int(length * 1.4))
        t = np.linspace(0, 1, steps)
        samples = p[0][None, :] * (1 - t[:, None]) + p[1][None, :] * t[:, None]
        x, y = np.rint(samples[:, 0]).astype(int), np.rint(samples[:, 1]).astype(int)
        valid = (x >= 1) & (x < width - 1) & (y >= 1) & (y < height - 1)
        x, y, z = x[valid], y[valid], samples[valid, 2]
        visible = np.isfinite(depth[y, x]) & (z >= depth[y, x] - 0.14)
        if not visible.any():
            continue
        x, y = x[visible], y[visible]
        perpendicular = np.array([-delta[1], delta[0]]) / length
        ox, oy = np.rint(perpendicular * 2).astype(int)
        xa, ya = np.clip(x + ox, 0, width - 1), np.clip(y + oy, 0, height - 1)
        xb, yb = np.clip(x - ox, 0, width - 1), np.clip(y - oy, 0, height - 1)
        dot = (normal_buffer[ya, xa] * normal_buffer[yb, xb]).sum(axis=1)
        crease = ~np.isfinite(depth[ya, xa]) | ~np.isfinite(depth[yb, xb]) | (dot < np.cos(np.deg2rad(18)))
        x, y = x[crease], y[crease]
        for dx, dy in [(0, 0), (0, 1)]:
            xx, yy = x + dx, y + dy
            ink = np.isfinite(depth[yy, xx])
            rgb[yy[ink], xx[ink]] = rgb[yy[ink], xx[ink]] * 0.61 + color * 0.39


def render_part(data, view, width, height):
    vertices = np.asarray(data["mesh"]["vertices"], dtype=float).reshape(-1, 3)
    normals = np.asarray(data["mesh"]["normals"], dtype=float).reshape(-1, 3)
    triangles = np.asarray(data["mesh"]["triangles"], dtype=np.int64).reshape(-1, 3)
    edge_lines = np.asarray(data["edges"]["lines"], dtype=float).reshape(-1, 2, 3)
    assert np.isfinite(vertices).all() and np.isfinite(normals).all()
    cam = camera(vertices, view, width, height, margin=40 * SS)
    depth, normal_buffer = rasterize(vertices, triangles, normals, cam)
    mask = np.isfinite(depth)
    yy, xx = np.nonzero(mask)
    n = normal_buffer[mask]
    # 从正交投影及深度还原真实表面点，用同一网格计算光源遮挡。
    horizontal = (xx + 0.5 - width / 2) / cam["scale"] + cam["middle"][0]
    vertical = -(yy + 0.5 - height / 2) / cam["scale"] + cam["middle"][1]
    points = (cam["center"] + horizontal[:, None] * cam["right"]
              + vertical[:, None] * cam["up"] + depth[mask, None] * cam["view"])
    key = unit(cam["view"] * 0.95 + cam["up"] * 0.70 - cam["right"] * 0.55)
    fill = unit(cam["view"] * 0.85 + cam["right"] * 0.65 - cam["up"] * 0.10)
    light_cam = camera(vertices, key, 1000, 1000, margin=30)
    shadow_depth, _ = rasterize(vertices, triangles, normals, light_cam, with_normals=False)
    light_points = project(points, light_cam)
    sx, sy = np.rint(light_points[:, 0]).astype(int), np.rint(light_points[:, 1]).astype(int)
    shadows = np.zeros(len(points), dtype=float)
    light_cosine = np.maximum(0, n @ key)
    # 斜入射表面的深度梯度更大，使用坡度相关偏移抑制阴影贴图自遮挡条纹。
    shadow_bias = 0.25 + 0.75 * (1 - light_cosine)
    for dx, dy in [(0, 0), (-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1), (-1, 1), (1, -1)]:
        sample_x, sample_y = np.clip(sx + dx, 0, 999), np.clip(sy + dy, 0, 999)
        shadows += (shadow_depth[sample_y, sample_x] > light_points[:, 2] + shadow_bias)
    visibility = 1 - 0.76 * shadows / 9
    diffuse = 0.36 + 0.65 * light_cosine * visibility + 0.24 * np.maximum(0, n @ fill)
    half = unit(key + cam["view"])
    specular = 0.24 * np.maximum(0, n @ half) ** 48 * visibility
    fresnel = 0.065 * np.maximum(0, 1 - n @ cam["view"]) ** 3
    colors = np.array([0.65, 0.69, 0.73])[None, :] * diffuse[:, None] + specular[:, None] + fresnel[:, None]
    rgb = np.ones((height, width, 3), dtype=float)
    rgb[mask] = np.clip(colors, 0, 0.97)
    visible_edges(rgb, depth, normal_buffer, edge_lines, cam)
    rgba = np.zeros((height, width, 4), dtype=np.uint8)
    rgba[:, :, :3] = np.uint8(np.clip(rgb, 0, 1) * 255)
    rgba[:, :, 3] = np.uint8(mask) * 255
    details = {"triangles": len(triangles), "view": list(view)}
    if data["presetId"] == "cup-housing":
        details["radialHolePixel"] = project(np.array([[46.0, 40.0, 0.0]]), cam)[0, :2].tolist()
    return Image.fromarray(rgba), details


def find_font(explicit):
    candidates = [explicit, os.environ.get("ROTOR_CJK_FONT"),
                  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
                  "/usr/share/fonts/truetype/noto/NotoSansSC-Regular.ttf"]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(candidate)
    raise SystemExit("请通过 --font 或 ROTOR_CJK_FONT 指定支持中文的字体，例如 Noto Sans CJK。")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mesh-dir", type=Path, default=Path("/tmp/rotor-studio-v1.2-mesh"))
    parser.add_argument("--output", type=Path, default=ROOT / "docs/screenshots/rotational-parts-v1.2.png")
    parser.add_argument("--font")
    args = parser.parse_args()
    font_path = find_font(args.font)
    font = lambda size: ImageFont.truetype(font_path, round(size * SS))
    background = Image.new("RGB", (WIDTH * SS, HEIGHT * SS), "#f1f5f8")
    draw = ImageDraw.Draw(background)
    text = lambda xy, content, size, color: draw.text((round(xy[0] * SS), round(xy[1] * SS)),
                                                     content, font=font(size), fill=color)
    text((60, 34), "ROTOR STUDIO  /  V1.2", 16, "#357d80")
    text((58, 73), "盘、套、壳体 · 参数化实体示例", 39, "#243844")
    text((60, 137), "独立内外轮廓  /  径向孔  /  内外环槽", 21, "#637888")
    items = [
        {"id": "flange-disk", "title": "六孔法兰盘", "size": "Ø100 × 30 mm",
         "view": [-0.94, 0.24, 0.24], "notes": ["6 × Ø6.6 贯穿孔", "中心通孔 Ø28 · 轮毂外环槽"]},
        {"id": "independent-sleeve", "title": "独立内阶梯套", "size": "Ø62 × 100 mm",
         "view": [0.80, -0.42, 0.42], "notes": ["内外阶梯独立 · 内锥过渡", "内密封环槽 · 内键槽"]},
        {"id": "cup-housing", "title": "杯形安装壳", "size": "Ø96 × 80 mm",
         "view": [0.90, 0.33, 0.28], "notes": ["盲腔 Ø60 × 62 mm · 底厚 18 mm", "2 × M6 径向穿壁孔（简化）"]},
    ]
    evidence = []
    card_top, card_width, card_height, gap = 216, 584, 624, 24
    for index, item in enumerate(items):
        x = 60 + index * (card_width + gap)
        draw.rounded_rectangle((x * SS, card_top * SS, (x + card_width) * SS, (card_top + card_height) * SS),
                               radius=18 * SS, fill="#ffffff", outline="#dce5eb", width=SS)
        text((x + 28, card_top + 22), f"0{index + 1}", 16, "#47898c")
        text((x + 28, card_top + 54), item["title"], 28, "#243844")
        text((x + 28, card_top + 99), item["size"], 18, "#78909d")
        data = json.loads((args.mesh_dir / f"{item['id']}.mesh.json").read_text())
        part, details = render_part(data, item["view"], card_width * SS, 406 * SS)
        # 柔和浮影仅用于背景层，不覆盖零件，更不添加任何实体细节。
        shadow = Image.new("RGBA", part.size, (28, 52, 67, 0))
        shadow.putalpha(part.getchannel("A").filter(ImageFilter.GaussianBlur(14 * SS)).point(lambda value: round(value * 0.12)))
        at = (x * SS, (card_top + 142) * SS)
        background.paste(shadow, (at[0], at[1] + 14 * SS), shadow)
        background.paste(part, at, part)
        if "radialHolePixel" in details:
            px, py = details["radialHolePixel"]
            point = (at[0] + round(px), at[1] + round(py))
            elbow = ((x + 456) * SS, (card_top + 208) * SS)
            draw.line((point, elbow, ((x + 526) * SS, elbow[1])), fill="#60979b", width=SS)
            draw.ellipse((point[0] - 4 * SS, point[1] - 4 * SS, point[0] + 4 * SS, point[1] + 4 * SS),
                         outline="#60979b", width=SS)
            text((x + 465, card_top + 178), "径向孔", 16, "#4b7e83")
        draw.line(((x + 28) * SS, (card_top + 534) * SS, (x + card_width - 28) * SS, (card_top + 534) * SS),
                  fill="#e6edf1", width=SS)
        for line, content in enumerate(item["notes"]):
            text((x + 28, card_top + 551 + line * 30), content, 19, "#4d6676")
        evidence.append({"presetId": item["id"], "source": str(args.mesh_dir / f"{item['id']}.mesh.json"), **details})
    text((60, 883), "实际 OpenCascade 实体软件渲染 · 螺纹为简化底孔", 21, "#435f70")
    text((60, 925), "三个示例均通过实体校验与 STEP 回读。视图采用独立取景比例。", 17, "#7a8e9b")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    background.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS).save(args.output, optimize=True)
    print(json.dumps({"output": str(args.output), "size": [WIDTH, HEIGHT], "renderer": "orthographic software z-buffer with mesh shadow map",
                      "parts": evidence}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
