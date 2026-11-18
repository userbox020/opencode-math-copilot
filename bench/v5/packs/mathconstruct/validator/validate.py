"""JSON-only adapter for trusted MathConstruct checkers; never evaluates answers."""

import contextlib
from fractions import Fraction
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import sys
import types

sys.dont_write_bytecode = True
CLONE = Path(
    r"C:\Users\MiPC\AppData\Local\Temp\opencode\math-benchmarks-20261117\mathconstruct"
)
TASKS = Path(__file__).resolve().parent.parent / "tasks.json"
SCHEMA = "mathconstruct-validator/v1"


def receipt(task_id, status, tag, reason):
    return dict(schema=SCHEMA, task_id=task_id, status=status, tag=tag, reason=reason)


def load_problem(task, clone=CLONE):
    """Load only the manifest-selected module, not the eager upstream registry."""
    module_name, target = task["grading"]["validator"].split(":")
    class_name, method = target.split(".")
    if (
        method != "check"
        or not re.fullmatch(r"math_construct\.problems\.[a-z_0-9]+\.[a-z_0-9]+", module_name)
        or not class_name.isidentifier()
    ):
        raise ValueError("Unsupported validator reference")
    source = (clone / task["metadata"]["source_file"]).resolve()
    expected = (clone / "src" / Path(*module_name.split("."))).with_suffix(".py").resolve()
    if source != expected or not source.is_relative_to((clone / "src").resolve()):
        raise ValueError("Validator path does not match trusted manifest")
    if hashlib.sha256(source.read_bytes()).hexdigest() != task["metadata"]["source_sha256"]:
        raise ValueError("Validator source hash does not match trusted manifest")
    sys.path.insert(0, str(clone / "src"))
    # The registry imports every problem. Package shells allow targeted loading.
    for name in ("math_construct.problems", module_name.rsplit(".", 1)[0]):
        if name not in sys.modules:
            package = types.ModuleType(name)
            package.__path__ = [str(clone / "src" / Path(*name.split(".")))]
            sys.modules[name] = package
    spec = importlib.util.spec_from_file_location(module_name, source)
    module = importlib.util.module_from_spec(spec)
    # Upstream get_problem_name splits __file__ on '/', including on Windows.
    module.__file__ = source.as_posix()
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    problem_class = getattr(module, class_name)
    if problem_class.config.name != task["id"]:
        raise ValueError("Problem name does not match task")
    parameters = task["metadata"]["original_parameters"]
    if parameters != problem_class.config.original_parameters:
        raise ValueError("Task parameters do not match upstream original")
    return problem_class(**parameters)


def construct_answer(value, example, primitive):
    """Restore list/tuple and Fraction types without parsing code or expressions."""
    if isinstance(example, (list, tuple)):
        if not isinstance(value, list):
            raise ValueError("Expected a JSON array")
        if not example:
            if value:
                raise ValueError("Cannot infer nonempty answer type")
            return []
        converted = [
            construct_answer(item, example[min(i, len(example) - 1)], primitive)
            for i, item in enumerate(value)
        ]
        return tuple(converted) if isinstance(example, tuple) else converted
    expected_type = primitive or type(example)
    if expected_type is Fraction:
        if type(value) is int:
            return Fraction(value)
        if isinstance(value, str) and re.fullmatch(r"[+-]?\d+(?:/[+-]?\d+)?", value):
            return Fraction(value)
        raise ValueError("Expected an integer or exact fraction string p/q")
    if expected_type is int and type(value) is int:
        return value
    if expected_type is float and type(value) in (int, float) and math.isfinite(value):
        return value
    if expected_type is str and type(value) is str:
        return value
    raise ValueError(f"Expected {expected_type.__name__}, not {type(value).__name__}")


def validate(request):
    task_id = request.get("task_id") if isinstance(request, dict) else None
    if not isinstance(task_id, str):
        return receipt(None, "rejected", "INVALID_REQUEST", "task_id must be a string")
    if "answer" not in request:
        return receipt(task_id, "rejected", "INVALID_REQUEST", "Missing answer")
    try:
        tasks = json.loads(TASKS.read_text(encoding="utf-8"))
        task = next((item for item in tasks if item["id"] == task_id), None)
        if task is None:
            return receipt(task_id, "unavailable", "UNKNOWN_TASK", "Task is not in tasks.json")
        problem = load_problem(task)
    except Exception as error:
        return receipt(task_id, "unavailable", "LOAD_ERROR", f"{type(error).__name__}: {error}")
    try:
        answer = construct_answer(
            request["answer"], problem.config.original_solution, problem.get_primitive_type()
        )
    except Exception as error:
        return receipt(task_id, "rejected", "MALFORMED_ANSWER", f"{type(error).__name__}: {error}")
    try:
        result = problem.check(answer)
        from math_construct.problems.problem import CheckerTag

        if type(result) is bool:
            correct, reason, tag = result, "Checker returned no details", CheckerTag.UNKNOWN
        elif type(result) is tuple and len(result) in (2, 3):
            correct, reason = result[:2]
            tag = result[2] if len(result) == 3 else CheckerTag.UNKNOWN
        else:
            raise TypeError("Unexpected checker result")
        if type(correct) is not bool or not isinstance(reason, str) or not isinstance(tag, CheckerTag):
            raise TypeError("Invalid checker result types")
        return receipt(task_id, "accepted" if correct else "rejected", tag.name, reason)
    except Exception as error:
        return receipt(task_id, "unavailable", "VALIDATOR_EXCEPTION", f"{type(error).__name__}: {error}")


def reject_constant(value):
    raise ValueError(f"Non-finite JSON constant: {value}")


def main():
    try:
        request = json.load(sys.stdin, parse_constant=reject_constant)
    except Exception as error:
        result = receipt(None, "rejected", "INVALID_JSON", f"{type(error).__name__}: {error}")
    else:
        # Checker/import diagnostics must not corrupt the stdout JSON protocol.
        with contextlib.redirect_stdout(sys.stderr):
            result = validate(request)
    print(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    main()
