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
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return "", err
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
	return hex.EncodeToString(hasher.Sum(nil)), nil
}