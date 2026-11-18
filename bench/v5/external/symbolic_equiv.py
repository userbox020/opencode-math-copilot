"""Bounded, numeric-only symbolic comparison; launched with a 5 s parent timeout."""

import ast
import json
import re
import sys


FUNCTIONS = {"sqrt", "sin", "cos", "tan"}
CONSTANTS = {"pi", "e"}


def normalize(value):
    if not isinstance(value, str) or not value or len(value) > 512:
        raise ValueError("Expected a nonempty expression of at most 512 characters")
    if re.search(r"_|:|['\"`]|import|lambda|exec|eval|open|os\.|sys\.", value, re.I):
        raise ValueError("Forbidden input")
    value = re.sub(r"\\[()[\]]|\$|\\(?:displaystyle|left|right)\b|\\[,!; ]", "", value)
    if not re.fullmatch(r"[A-Za-z0-9\\{}().+*/^\-\s]+", value):
        raise ValueError("Outside character allowlist")
    position = 0

    def spaces():
        nonlocal position
        while position < len(value) and value[position].isspace():
            position += 1

    def piece(argument=False):
        nonlocal position
        spaces()
        if position >= len(value):
            raise ValueError("Missing LaTeX argument")
        char = value[position]
        position += 1
        if char == "{":
            parts = []
            spaces()
            while position < len(value) and value[position] != "}":
                parts.append(piece())
                spaces()
            if position >= len(value):
                raise ValueError("Unclosed group")
            position += 1
            return "(" + "".join(parts) + ")"
        if char == "\\":
            match = re.match(r"[A-Za-z]+", value[position:])
            if not match:
                raise ValueError("Unknown LaTeX command")
            command = match.group()
            position += len(command)
            if command == "frac":
                numerator, denominator = piece(True), piece(True)
                return "((" + numerator + ")/(" + denominator + "))"
            if command == "sqrt":
                return "sqrt(" + piece(True) + ")"
            if command in {"pi", "sin", "cos", "tan"}:
                return command
            if command in {"cdot", "times"} and not argument:
                return "*"
            raise ValueError("Unsupported LaTeX command")
        if char == "}" or (argument and not char.isalnum()):
            raise ValueError("Invalid LaTeX argument")
        return char

    parts = []
    while position < len(value):
        spaces()
        if position < len(value):
            parts.append(piece())
    text = "".join(parts).replace("^", "**")
    tokens = re.findall(r"\d+(?:\.\d+)?|\.\d+|[A-Za-z]+|\*\*|[()+*/-]", text)
    if "".join(tokens) != text:
        raise ValueError("Unsupported expression tokens")
    for token in tokens:
        if token[0].isalpha() and token not in FUNCTIONS | CONSTANTS:
            raise ValueError("Free symbols or unknown names are unsupported")
    # Insert only mathematical implicit multiplication, never arbitrary Python calls.
    result = []
    for i, token in enumerate(tokens):
        previous = tokens[i - 1] if i else None
        end = previous is not None and (previous == ")" or previous in CONSTANTS or previous[0].isdigit() or previous[0] == ".")
        start = token == "(" or token in FUNCTIONS | CONSTANTS or token[0].isdigit() or token[0] == "."
        if end and start:
            if previous[0] in "0123456789." and token[0] in "0123456789.":
                raise ValueError("Adjacent numeric literals")
            result.append("*")
        result.append(token)
    text = "".join(result)
    tree = ast.parse(text, mode="eval")

    def validate(node):
        if isinstance(node, ast.Expression):
            validate(node.body)
        elif isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow)):
            validate(node.left)
            validate(node.right)
        elif isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            validate(node.operand)
        elif isinstance(node, ast.Constant) and type(node.value) in (int, float):
            pass
        elif isinstance(node, ast.Name) and node.id in CONSTANTS:
            pass
        elif (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
              and node.func.id in FUNCTIONS and len(node.args) == 1 and not node.keywords):
            validate(node.args[0])
        else:
            raise ValueError("Outside arithmetic grammar")

    validate(tree)
    return text


def compare(payload):
    # Validate before importing SymPy, and never pass raw extracted text to its parser.
    expected, extracted = normalize(payload["expected"]), normalize(payload["extracted"])
    try:
        import sympy as sp
        from sympy.parsing.sympy_parser import auto_number, parse_expr, rationalize
    except ImportError:
        return {"status": "unparseable", "reason": "SymPy is unavailable"}
    namespace = {
        "__builtins__": {}, "Integer": sp.Integer, "Float": sp.Float, "Rational": sp.Rational,
        "sqrt": sp.sqrt, "sin": sp.sin, "cos": sp.cos, "tan": sp.tan,
        "pi": sp.pi, "e": sp.E,
    }
    def parse(text):
        return parse_expr(text, local_dict={}, global_dict=namespace,
                          transformations=(auto_number, rationalize))

    a, b = parse(expected), parse(extracted)
    if a.free_symbols or b.free_symbols:
        return {"status": "unparseable", "reason": "Free symbols are unsupported"}
    if a.is_finite is not True or b.is_finite is not True:
        return {"status": "unparseable", "reason": "Nonfinite or uncertain expression"}
    if sp.simplify(a - b) == 0:
        return {"status": "equivalent", "reason": "SymPy simplified the difference to zero"}
    equal = a.equals(b)
    if equal is True:
        return {"status": "equivalent", "reason": "SymPy established equality"}
    # Do not turn a proved inequality (including very close exact numbers) into a pass.
    if equal is False:
        return {"status": "different", "reason": "SymPy established inequality of finite, symbol-free expressions"}
    # Numerical fallback is limited to finite real constants; uncertainty stays ungraded.
    if a.is_real is True and b.is_real is True:
        av, bv = a.evalf(80, strict=True), b.evalf(80, strict=True)
        if av.is_finite is True and bv.is_finite is True:
            scale = max(abs(av), abs(bv))
            if scale > 0 and abs(av - bv) <= sp.Rational(1, 10**12) * scale:
                return {"status": "equivalent", "reason": "Finite constants agree within 1e-12 relative tolerance"}
    return {"status": "unparseable", "reason": "Equivalence is uncertain"}


def main():
    try:
        raw = sys.stdin.read(8193)
        if len(raw) > 8192:
            raise ValueError("Input too large")
        result = compare(json.loads(raw))
    except Exception as error:
        result = {"status": "unparseable", "reason": "Restricted symbolic comparison: " + type(error).__name__ + ": " + str(error)}
    print(json.dumps(result))


if __name__ == "__main__":
    main()
