"""把白底 JPG 图标转成真透明 PNG（对白底做精确逆混合，保留抗锯齿边缘）。

用法: python white-to-alpha.py <in.jpg> <out.png>
原理: 白底合成 observed = C*a + 255*(1-a)，逆解 a = 255 - min(r,g,b)，
      C = 255*(observed - (255-a)) / a。全白像素 alpha=0，边缘半透明自然过渡。
"""
import sys

from PIL import Image


def white_to_alpha(src: str, dst: str) -> None:
    im = Image.open(src).convert("RGB")
    w, h = im.size
    out = Image.new("RGBA", (w, h))
    src_px = im.load()
    dst_px = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b = src_px[x, y]
            a = 255 - min(r, g, b)
            if a <= 0:
                dst_px[x, y] = (0, 0, 0, 0)
            elif a >= 255:
                dst_px[x, y] = (r, g, b, 255)
            else:
                nr = max(0, min(255, round(255 * (r - (255 - a)) / a)))
                ng = max(0, min(255, round(255 * (g - (255 - a)) / a)))
                nb = max(0, min(255, round(255 * (b - (255 - a)) / a)))
                dst_px[x, y] = (nr, ng, nb, a)
    out.save(dst)
    print(f"ok {dst} {w}x{h}")


if __name__ == "__main__":
    white_to_alpha(sys.argv[1], sys.argv[2])
