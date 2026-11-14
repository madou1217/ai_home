package serveridentity

import (
	"strconv"

	"golang.org/x/sys/windows"
)

func processStartID() (string, error) {
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(windows.CurrentProcess(), &created, &exited, &kernel, &user); err != nil {
		return "", err
	}
	return "windows:" + strconv.FormatInt(created.Nanoseconds()/1_000_000, 10), nil
}
