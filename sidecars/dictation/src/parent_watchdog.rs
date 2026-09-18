//! Terminate this detached worker and its descendants when its Electron owner dies.
//! Enabled only by the launcher-provided parent PID; standalone CLI use is unchanged.

#[cfg(unix)]
fn owns_process_group(pid: i32, group: i32) -> bool {
    pid > 1 && group == pid
}

#[cfg(unix)]
pub fn start() {
    use std::time::Duration;
    extern "C" {
        fn getpid() -> i32;
        fn getppid() -> i32;
        fn getpgrp() -> i32;
        fn kill(pid: i32, signal: i32) -> i32;
    }
    let expected_parent = match std::env::var("MEMO_PARENT_PID")
        .ok()
        .and_then(|value| value.parse::<i32>().ok())
    {
        Some(pid) if pid > 1 => pid,
        _ => return,
    };
    std::thread::spawn(move || loop {
        // A reparented child cannot regain its original parent, including PID reuse.
        if unsafe { getppid() } != expected_parent {
            let pid = unsafe { getpid() };
            if owns_process_group(pid, unsafe { getpgrp() }) {
                // SIGKILL reaches Conomo even if inference holds the engine mutex.
                unsafe {
                    kill(-pid, 9);
                }
            }
            // Never signal an inherited/shared process group.
            std::process::exit(1);
        }
        std::thread::sleep(Duration::from_secs(1));
    });
}

#[cfg(not(unix))]
pub fn start() {}

#[cfg(all(test, unix))]
mod tests {
    use super::owns_process_group;

    #[test]
    fn only_a_detached_group_leader_can_terminate_its_group() {
        assert!(owns_process_group(500, 500));
        assert!(!owns_process_group(500, 400));
        assert!(!owns_process_group(1, 1));
        assert!(!owns_process_group(0, 0));
        assert!(!owns_process_group(-1, -1));
    }
}
