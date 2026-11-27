package clipboard

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"image"
	"image/color"
)

// canonicalImageSHA hashes the visible RGB pixels plus dimensions instead of
// the encoded file bytes. Windows clipboard providers can alternate PNG alpha
// representations for the same screenshot; hashing raw bytes then creates a
// new history row every poll. Alpha values are intentionally ignored.
func canonicalImageSHA(data []byte) (string, error) {
	sha, _, err := canonicalImageIdentity(data)
	return sha, err
}

func canonicalImageIdentity(data []byte) (string, string, error) {
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return "", "", err
	}
	bounds := img.Bounds()
	hasher := sha256.New()
	_, _ = hasher.Write([]byte("aih-image-rgb-v1\x00"))
	var header [8]byte
	binary.BigEndian.PutUint32(header[0:4], uint32(bounds.Dx()))
	binary.BigEndian.PutUint32(header[4:8], uint32(bounds.Dy()))
	_, _ = hasher.Write(header[:])
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			nrgba := color.NRGBAModel.Convert(img.At(x, y)).(color.NRGBA)
			_, _ = hasher.Write([]byte{nrgba.R, nrgba.G, nrgba.B})
		}
	}
	return hex.EncodeToString(hasher.Sum(nil)), perceptualHash(img), nil
}

// perceptualHash is a 64-bit dHash over a 9x8 grayscale thumbnail. Equal-size
// screenshot frames that differ only by a cursor or tiny visual changes stay
// within a small Hamming distance.
func perceptualHash(img image.Image) string {
	bounds := img.Bounds()
	if bounds.Dx() <= 0 || bounds.Dy() <= 0 {
		return ""
	}
	var bits uint64
	var previous int
	index := 0
	for y := 0; y < 8; y++ {
		for x := 0; x < 9; x++ {
			sx := bounds.Min.X + x*bounds.Dx()/9
			sy := bounds.Min.Y + y*bounds.Dy()/8
			if sx >= bounds.Max.X {
				sx = bounds.Max.X - 1
			}
			if sy >= bounds.Max.Y {
				sy = bounds.Max.Y - 1
			}
			gray := color.GrayModel.Convert(img.At(sx, sy)).(color.Gray).Y
			if x > 0 && int(gray) > previous {
				bits |= 1 << uint(63-index)
			}
			if x > 0 {
				index++
			}
			previous = int(gray)
		}
	}
	if index == 0 {
		return ""
	}
	var out [16]byte
	const digits = "0123456789abcdef"
	for i := 0; i < 16; i++ {
		shift := uint(60 - (i%16)*4)
		nibble := (bits >> shift) & 0xf
		out[i] = digits[nibble]
	}
	return string(out[:])
}

// PerceptualDistance counts differing bits between two 16-hex dHash values.
func PerceptualDistance(left, right string) int {
	if len(left) != 16 || len(right) != 16 {
		return 64
	}
	var result int
	for i := 0; i < 16; i++ {
		a := hexNibble(left[i])
		b := hexNibble(right[i])
		if a < 0 || b < 0 {
			return 64
		}
		xor := a ^ b
		for xor != 0 {
			result += int(xor & 1)
			xor >>= 1
		}
	}
	return result
}

func hexNibble(value byte) int {
	switch {
	case value >= '0' && value <= '9':
		return int(value - '0')
	case value >= 'a' && value <= 'f':
		return int(value-'a') + 10
	case value >= 'A' && value <= 'F':
		return int(value-'A') + 10
	default:
		return -1
	}
}
