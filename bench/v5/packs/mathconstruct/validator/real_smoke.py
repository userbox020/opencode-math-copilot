"""Opt-in local checker controls, separate from the default Node contract tests."""

import json
from pathlib import Path
import subprocess
import sys

sys.dont_write_bytecode = True
from validate import TASKS, load_problem


tasks = json.loads(TASKS.read_text(encoding="utf-8"))
pilot_ids = {
    task["id"]
    for task in json.loads(TASKS.with_name("pilot.json").read_text(encoding="utf-8"))
}
script = Path(__file__).with_name("validate.py")
count = 0
for task_id, negative in [("dutch-2019-2", []), ("emc-2021-1", [0])]:
    assert task_id in pilot_ids
    task = next(task for task in tasks if task["id"] == task_id)
    problem = load_problem(task)
    original = problem.config.original_solution
    direct = problem.check(original)
    assert direct[0] is True and direct[2].name == "CORRECT", direct
    print(json.dumps({
        "control": "direct-original", "task_id": task_id, "status": "accepted",
        "tag": direct[2].name, "tag_value": direct[2].value, "reason": direct[1],
    }))
    for answer, status, tag in [
        (original, "accepted", "CORRECT"),
        (negative, "rejected", "INCORRECT_LENGTH"),
    ]:
        completed = subprocess.run(
            [sys.executable, "-B", str(script)],
            input=json.dumps({"task_id": task_id, "answer": answer}),
            text=True, capture_output=True, timeout=60, check=True, shell=False,
        )
        result = json.loads(completed.stdout)
        assert result["schema"] == "mathconstruct-validator/v1", result
        assert result["task_id"] == task_id, result
        assert result["status"] == status and result["tag"] == tag, result
        print(json.dumps(result))
        count += 1
print(f"PASS: {count} real bridge controls and 2 direct original-solution checks")
