//go:build windows

package artifactstore

import (
	"encoding/binary"
	"os"
	"syscall"
)

// Windows 目录 junction（与 Node 的 fs.symlinkSync(target, link, 'junction') 等价）。
//
// 为什么不用 mklink /J：那是外部进程，PATH/ComSpec 缺失时会失败；而 os.Symlink 需要
// 开发者模式或管理员权限，普通用户直接 EPERM。junction 只是"挂载点重解析"，任何用户
// 都能在自己有写权限的目录上创建，所以直接用 FSCTL_SET_REPARSE_POINT。
const (
	fsctlSetReparsePoint   = 0x000900A4
	ioReparseTagMountPoint = 0xA0000003
	mountPointDataOffset   = 8 // ULONG tag + USHORT length + USHORT reserved
)

// createJunction 在 link 上创建指向 target 的目录 junction。
// link 必须不存在（或为空目录，由本函数创建）。
func createJunction(target, link string) error {
	if err := os.Mkdir(link, 0o755); err != nil {
		return err
	}
	substitute, err := syscall.UTF16FromString("\\??\\" + target)
	if err != nil {
		return err
	}
	printName, err := syscall.UTF16FromString(target)
	if err != nil {
		return err
	}
	// 两个名字都以 NUL 结尾，长度按"不含 NUL"的字节数记录。
	// 挂载点重解析没有 Flags 字段（只有符号链接才有）：4 个 USHORT 之后就是名字缓冲。
	nameBytes := len(substitute)*2 + len(printName)*2
	buffer := make([]byte, mountPointDataOffset+8+nameBytes)
	binary.LittleEndian.PutUint32(buffer[0:4], ioReparseTagMountPoint)
	binary.LittleEndian.PutUint16(buffer[4:6], uint16(8+nameBytes))
	binary.LittleEndian.PutUint16(buffer[6:8], 0)
	binary.LittleEndian.PutUint16(buffer[8:10], 0)                              // SubstituteNameOffset
	binary.LittleEndian.PutUint16(buffer[10:12], uint16((len(substitute)-1)*2)) // SubstituteNameLength
	binary.LittleEndian.PutUint16(buffer[12:14], uint16(len(substitute)*2))     // PrintNameOffset
	binary.LittleEndian.PutUint16(buffer[14:16], uint16((len(printName)-1)*2))  // PrintNameLength
	offset := 16
	for _, char := range substitute {
		binary.LittleEndian.PutUint16(buffer[offset:offset+2], char)
		offset += 2
	}
	for _, char := range printName {
		binary.LittleEndian.PutUint16(buffer[offset:offset+2], char)
		offset += 2
	}

	pointer, err := syscall.UTF16PtrFromString(link)
	if err != nil {
		return err
	}
	handle, err := syscall.CreateFile(
		pointer,
		syscall.GENERIC_WRITE,
		0,
		nil,
		syscall.OPEN_EXISTING,
		syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT,
		0,
	)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(handle)
	var returned uint32
	return syscall.DeviceIoControl(
		handle,
		fsctlSetReparsePoint,
		&buffer[0],
		uint32(len(buffer)),
		nil,
		0,
		&returned,
		nil,
	)
}
