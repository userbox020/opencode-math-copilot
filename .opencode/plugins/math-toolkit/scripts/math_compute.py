"""Bounded, allowlisted SymPy expressions; never evaluate Python source."""

import ast
import io
import json
import math
import re
import sys
import tokenize


class InputError(ValueError):
    pass


SYMBOLS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ") | {
    "alpha", "beta", "gamma", "theta", "phi", "lambda", "mu", "nu",
    "pi", "oo",
}
OPERATIONS = {
    "simplify", "factor", "expand", "solve", "diff", "integrate",
    "limit", "series", "evalf", "det", "eigenvalues",
}


def bounded_integer(value, name, low, high):
    if type(value) is not int or not low <= value <= high:
        raise InputError(f"{name} must be an integer from {low} to {high}.")
    return value


def number(value, sp):
    if type(value) is int:
        if len(str(abs(value))) > 100:
            raise InputError("Integer constants are limited to 100 digits.")
        return sp.Integer(value)
    if type(value) is float and math.isfinite(value):
        return sp.Float(value)
    raise InputError("Only finite integer and float constants are allowed.")


def expression(source, sp):
    if not isinstance(source, str) or not source.strip() or len(source) > 2000:
        raise InputError("Expression must contain 1 to 2000 characters.")
    functions = {
        "sin": sp.sin, "cos": sp.cos, "tan": sp.tan, "exp": sp.exp,
        "log": sp.log, "sqrt": sp.sqrt, "abs": sp.Abs, "factorial": sp.factorial,
    }
    constants = {"pi": sp.pi, "E": sp.E, "I": sp.I, "oo": sp.oo}
    # Token-based normalization supports conventional ^ and the symbol lambda.
    tokens = []
    for token in tokenize.generate_tokens(io.StringIO(source.strip()).readline):
        kind, text = token.type, token.string
        if kind == tokenize.NAME:
            if text not in SYMBOLS and text not in functions:
                raise InputError("Unknown or forbidden name in expression.")
            if text == "lambda":
                text = "_lambda"
        elif kind == tokenize.NUMBER:
            if sum(char.isdigit() for char in text) > 100:
                raise InputError("Numeric constants are limited to 100 digits.")
            if not re.fullmatch(r"(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", text):
                raise InputError("Only decimal numeric constants are allowed.")
        elif kind == tokenize.OP and text == "^":
            text = "**"
        elif kind in (tokenize.STRING, tokenize.COMMENT):
            raise InputError("Strings and comments are not allowed.")
        tokens.append((kind, text))
    tree = ast.parse(tokenize.untokenize(tokens), mode="eval")
    pending = [(tree, 1)]
    count = 0
    while pending:
        node, depth = pending.pop()
        count += 1
        if count > 500 or depth > 50:
            raise InputError("Expression exceeds 500 AST nodes or depth 50.")
        pending.extend((child, depth + 1) for child in ast.iter_child_nodes(node))

    def translate(node):
        if isinstance(node, ast.Constant):
            return number(node.value, sp)
        if isinstance(node, ast.Name):
            name = "lambda" if node.id == "_lambda" else node.id
            if name not in SYMBOLS:
                raise InputError("Only allowed symbols may be used as values.")
            return constants[name] if name in constants else sp.Symbol(name)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = translate(node.operand)
            return value if isinstance(node.op, ast.UAdd) else -value
        if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow)):
            left, right = translate(node.left), translate(node.right)
            if isinstance(node.op, ast.Add):
                result = left + right
            elif isinstance(node.op, ast.Sub):
                result = left - right
            elif isinstance(node.op, ast.Mult):
                result = left * right
            elif isinstance(node.op, ast.Div):
                result = left / right
            else:
                if right.is_number:
                    if right.is_real is not True or not bool(sp.Abs(right) <= 1000):
                        raise InputError("Numeric exponent magnitude is limited to 1000.")
                    # Reject nested numeric powers before creating enormous integers.
                    if left.is_Rational and right.is_Integer:
                        bits = max(abs(int(left.p)).bit_length(), int(left.q).bit_length())
                        if bits * abs(int(right)) > 3300:
                            raise InputError("Numeric power is too large.")
                result = left ** right
            if result.is_Rational and max(abs(int(result.p)).bit_length(), int(result.q).bit_length()) > 3300:
                raise InputError("Numeric intermediate is too large.")
            return result
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in functions:
                raise InputError("Only allowlisted function calls are allowed.")
            if node.keywords or len(node.args) != 1:
                raise InputError("Functions require exactly one positional argument.")
            value = translate(node.args[0])
            if node.func.id == "factorial" and value.is_number:
                if value.is_Integer is not True or not 0 <= value <= 1000:
                    raise InputError("Numeric factorial arguments must be integers from 0 to 1000.")
            return functions[node.func.id](value)
        raise InputError("Forbidden expression syntax.")

    return translate(tree.body)


def compute(args, sp):
    if not isinstance(args, dict):
        raise InputError("Arguments must be a JSON object.")
    operation = args.get("operation")
    if not isinstance(operation, str) or operation not in OPERATIONS:
        raise InputError("Unsupported operation.")
    if operation in ("det", "eigenvalues"):
        rows = args.get("matrix")
        if not isinstance(rows, list) or not 1 <= len(rows) <= 10:
            raise InputError("Matrix must be a square JSON array of size 1 to 10.")
        if any(not isinstance(row, list) or len(row) != len(rows) for row in rows):
            raise InputError("Matrix must be square and at most 10x10.")
        matrix = sp.Matrix([[number(value, sp) for value in row] for row in rows])
        return matrix.det() if operation == "det" else matrix.eigenvals()
    value = expression(args.get("expression"), sp)
    variable = args.get("variable", "x")
    if not isinstance(variable, str) or variable not in SYMBOLS or variable in {"pi", "E", "I", "oo"}:
        raise InputError("Variable must be an allowed nonconstant symbol.")
    symbol = sp.Symbol(variable)
    if operation == "simplify":
        return sp.simplify(value)
    if operation == "factor":
        return sp.factor(value)
    if operation == "expand":
        return sp.expand(value)
    if operation == "solve":
        return sp.solve(value, symbol)
    if operation == "diff":
        return sp.diff(value, symbol)
    if operation == "integrate":
        return sp.integrate(value, symbol)
    if operation == "evalf":
        return value.evalf(15)
    point = args.get("point", 0)
    point = expression(point, sp) if isinstance(point, str) else number(point, sp)
    if operation == "limit":
        return sp.limit(value, symbol, point)
    order = bounded_integer(args.get("order", 6), "order", 1, 50)
    return sp.series(value, symbol, point, order)


def main():
    try:
        if len(sys.argv) != 2 or len(sys.argv[1]) > 20000:
            raise InputError("Expected one bounded JSON argument object.")
        args = json.loads(sys.argv[1])
        try:
            import sympy as sp
        except ImportError:
            raise InputError("SymPy is missing; install it with python -m pip install sympy.") from None
        result = {"ok": True, "result": str(compute(args, sp))}
    except (SyntaxError, tokenize.TokenError, IndentationError):
        result = {"ok": False, "error": "Invalid expression syntax."}
    except Exception as error:
        # Do not include tracebacks, source snippets, or the original JSON payload.
        message = str(error) if isinstance(error, InputError) else f"Computation failed ({type(error).__name__})."
        result = {"ok": False, "error": message[:300]}
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
