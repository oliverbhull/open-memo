"""Read a complete MLX response without accepting a token-limit cutoff."""


class IncompleteGeneration(ValueError):
    """Generation stopped at a limit rather than the model's end marker."""


def complete_output(responses) -> str:
    parts = []
    finish_reason = None
    for response in responses:
        parts.append(response.text)
        finish_reason = response.finish_reason
    if finish_reason != "stop":
        raise IncompleteGeneration("generation did not finish")
    return "".join(parts).strip()
