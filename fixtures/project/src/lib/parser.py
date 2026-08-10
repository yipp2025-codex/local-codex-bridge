"""Small literal-search helper used only as synthetic source text."""


def find_literal(lines, query):
    normalized = query.casefold()
    return [line for line in lines if normalized in line.casefold()]
