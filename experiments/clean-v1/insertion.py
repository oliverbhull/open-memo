"""Pure insertion admission gate for future native AX integration; no app/clipboard access."""
from dataclasses import dataclass

@dataclass(frozen=True)
class Target:
    process: int
    window: str
    element: str
    selection: tuple[int, int]
    secure: bool = False
    literal: bool = False
    accessibility: bool = True


def admission(captured: Target | None, current: Target | None) -> str:
    if captured is None or current is None: return 'target_unknown'
    if not captured.accessibility or not current.accessibility: return 'accessibility_denied'
    if captured.secure or current.secure: return 'secure_field'
    if captured.literal or current.literal: return 'literal_field'
    if captured != current: return 'target_changed'
    return 'eligible'


def may_restore_clipboard(owned_change_count: int, current_change_count: int, paste_consumed: bool) -> bool:
    # A timer or successful Cmd-V dispatch cannot establish paste consumption.
    return paste_consumed and owned_change_count == current_change_count
