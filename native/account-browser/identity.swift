import AppKit
import Darwin
import Foundation

// Directly spawned applications need not have an NSRunningApplication launchDate.
// Bind input to the task parent's kernel process identity instead of that optional
// LaunchServices timestamp. The supervisor separately verifies the signed bundle.
struct TaskBrowserIdentity: Equatable {
  private let seconds: UInt64
  private let microseconds: UInt64

  static func read(_ pid: pid_t, parent: pid_t) throws -> TaskBrowserIdentity {
    guard pid > 1, parent > 1, getppid() == parent else { throw SurfaceFailure("browser_identity_unavailable") }
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
      info.pbi_pid == UInt32(pid), info.pbi_ppid == UInt32(parent),
      info.pbi_pgid == UInt32(pid), info.pbi_uid == geteuid(),
      info.pbi_start_tvsec > 0 else { throw SurfaceFailure("browser_identity_unavailable") }
    var path = [CChar](repeating: 0, count: Int(MAXPATHLEN) * 4)
    guard proc_pidpath(pid, &path, UInt32(path.count)) > 0,
      String(cString: path) == "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      let app = NSRunningApplication(processIdentifier: pid),
      app.bundleIdentifier == "com.microsoft.edgemac", !app.isTerminated else {
      throw SurfaceFailure("browser_identity_unavailable")
    }
    // Recheck the birth marker after the path/application queries as well.
    var after = proc_bsdinfo()
    guard getppid() == parent, proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, size) == size,
      after.pbi_pid == info.pbi_pid, after.pbi_ppid == info.pbi_ppid,
      after.pbi_pgid == info.pbi_pgid, after.pbi_uid == info.pbi_uid,
      after.pbi_start_tvsec == info.pbi_start_tvsec,
      after.pbi_start_tvusec == info.pbi_start_tvusec else {
      throw SurfaceFailure("browser_identity_unavailable")
    }
    return TaskBrowserIdentity(seconds: info.pbi_start_tvsec, microseconds: info.pbi_start_tvusec)
  }
}
