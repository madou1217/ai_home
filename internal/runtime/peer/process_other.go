//go:build !darwin && !linux

package peer

import "errors"

func processLaunch(int) ([]string, map[string]string, error) {
	return nil, nil, errors.New("peer_process_launch_unavailable")
}
