package sshbridge

import "regexp"

var (
	altVPattern          = regexp.MustCompile(`^\x1b[vV]$`)
	altVCsiUPattern      = regexp.MustCompile(`^\x1b\[(?:86|118);3(?:[:;]\d+)*u$`)
	altVModifyOtherKeys  = regexp.MustCompile(`^\x1b\[27;3;(?:86|118)(?:;\d+)*~$`)
	ctrlVPattern         = regexp.MustCompile(`^\x16$`)
	ctrlVCsiUPattern     = regexp.MustCompile(`^\x1b\[(?:86|118);(?:4|5)(?:[:;]\d+)*u$`)
	ctrlVModifyOtherKeys = regexp.MustCompile(`^\x1b\[27;(?:4|5);(?:86|118)(?:;\d+)*~$`)
)

// IsAltVClipboardTrigger 判断一段输入是否是 Alt+V 图像粘贴快捷键。
func IsAltVClipboardTrigger(data []byte) bool {
	text := string(data)
	return altVPattern.MatchString(text) || altVCsiUPattern.MatchString(text) || altVModifyOtherKeys.MatchString(text)
}

// IsCtrlVClipboardTrigger 判断一段输入是否是 Ctrl+V 图像粘贴快捷键。
func IsCtrlVClipboardTrigger(data []byte) bool {
	text := string(data)
	return ctrlVPattern.MatchString(text) || ctrlVCsiUPattern.MatchString(text) || ctrlVModifyOtherKeys.MatchString(text)
}
