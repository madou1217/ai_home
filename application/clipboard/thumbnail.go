package clipboard

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"

	_ "golang.org/x/image/webp"
)

const (
	thumbnailMaxEdge   = 320
	thumbnailMaxBytes  = 64 * 1024
	thumbnailInitQual  = 80
	thumbnailMinEdge   = 64
)

// GenerateThumbnail decodes PNG/JPEG/GIF/WebP bytes, resizes using nearest-neighbor to max 320px,
// and encodes as JPEG (starting at quality 80), shrinking quality/dimensions until <= 64 KiB.
func GenerateThumbnail(data []byte) (thumb []byte, width int, height int, err error) {
	if len(data) == 0 {
		return nil, 0, 0, ErrEmptyContent
	}
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, 0, 0, err
	}
	bounds := src.Bounds()
	width = bounds.Dx()
	height = bounds.Dy()
	if width <= 0 || height <= 0 {
		return nil, 0, 0, errors.New("clipboard_image_empty_bounds")
	}

	edge := thumbnailMaxEdge
	for {
		dstW, dstH := fitWithinEdge(width, height, edge)
		resized := resizeNearestOpaqueWhite(src, dstW, dstH)
		for _, quality := range []int{thumbnailInitQual, 65, 50, 35, 25} {
			var buf bytes.Buffer
			if encErr := jpeg.Encode(&buf, resized, &jpeg.Options{Quality: quality}); encErr != nil {
				return nil, width, height, encErr
			}
			if buf.Len() <= thumbnailMaxBytes {
				return buf.Bytes(), width, height, nil
			}
		}
		if edge <= thumbnailMinEdge || (dstW <= thumbnailMinEdge && dstH <= thumbnailMinEdge) {
			// Best effort fallback: encode at minimum size & quality.
			var buf bytes.Buffer
			if encErr := jpeg.Encode(&buf, resized, &jpeg.Options{Quality: 20}); encErr != nil {
				return nil, width, height, encErr
			}
			if buf.Len() <= thumbnailMaxBytes {
				return buf.Bytes(), width, height, nil
			}
			return nil, width, height, errors.New("clipboard_thumbnail_exceeds_limit")
		}
		edge = edge * 3 / 4
		if edge < thumbnailMinEdge {
			edge = thumbnailMinEdge
		}
	}
}

func fitWithinEdge(w, h, maxEdge int) (int, int) {
	if w <= maxEdge && h <= maxEdge {
		return w, h
	}
	if w >= h {
		dstW := maxEdge
		dstH := int(int64(h) * int64(maxEdge) / int64(w))
		if dstH < 1 {
			dstH = 1
		}
		return dstW, dstH
	}
	dstH := maxEdge
	dstW := int(int64(w) * int64(maxEdge) / int64(h))
	if dstW < 1 {
		dstW = 1
	}
	return dstW, dstH
}

// resizeNearestOpaqueWhite scales src to (dstW, dstH) using nearest-neighbor sampling
// and flattens alpha onto white so JPEG output has no black transparency artifacts.
func resizeNearestOpaqueWhite(src image.Image, dstW, dstH int) *image.RGBA {
	sb := src.Bounds()
	srcW := sb.Dx()
	srcH := sb.Dy()
	dst := image.NewRGBA(image.Rect(0, 0, dstW, dstH))
	for y := 0; y < dstH; y++ {
		sy := sb.Min.Y + (y*srcH)/dstH
		for x := 0; x < dstW; x++ {
			sx := sb.Min.X + (x*srcW)/dstW
			r16, g16, b16, a16 := src.At(sx, sy).RGBA()
			if a16 == 0xffff {
				dst.SetRGBA(x, y, color.RGBA{
					R: uint8(r16 >> 8),
					G: uint8(g16 >> 8),
					B: uint8(b16 >> 8),
					A: 0xff,
				})
				continue
			}
			// Alpha-premultiplied RGBA() composited over white (0xffff): out = premul + (0xffff - a)
			invA := 0xffff - a16
			r := (r16 + invA) >> 8
			g := (g16 + invA) >> 8
			b := (b16 + invA) >> 8
			if r > 0xff {
				r = 0xff
			}
			if g > 0xff {
				g = 0xff
			}
			if b > 0xff {
				b = 0xff
			}
			dst.SetRGBA(x, y, color.RGBA{R: uint8(r), G: uint8(g), B: uint8(b), A: 0xff})
		}
	}
	return dst
}
