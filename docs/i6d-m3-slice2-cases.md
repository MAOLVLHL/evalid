# M3 切片 2（#122）：断言执行门禁真实案例证据

总单 #119 验收第 2 项：≥3 个真实案例被门禁捕获——至少 1 个回调里从不执行的断言、至少 1 个看似合理但错误的期望值，第三个任一类；每个案例有复现前/后对照与判定输出（门禁判红并点名行号/断言）；至少 1 个走 JS 侧（V8 coverage）、至少 1 个走 pytest 侧。

## 案例性质（先说清楚）

本仓自有测试里**没有找到现成的历史真实 bug**可作案例：切片 2 编写时扫过 `test/*.test.js` 与 `src/` 中回调内的断言（`.on(` / `.then(` / `setTimeout` 回调），命中的只有切片 1 自带的 fixture 与 `test-gate-v2.test.js` 的 `emitter.on('data', onData)`（回调内无断言）；pytest 侧本仓根目录本就没有自有 pytest 测试树。因此以下 3 个案例是**构造的最小复现用例**（constructed minimal reproductions），不是历史真实 bug——它们跑的是真实门禁代码（`xflow/atoms/i6d_assertion_execution.py` 与 `i6d_assertion_execution_js.js`，切片 1 已合并），判定输出为实测结果。复现逻辑收进 `test/i6d-m3-real-cases.test.js`，CI 每次都会重跑验证。

## 案例总览

| 案例 | 类别 | 侧 | 复现前（RED） | 复现后（GREEN） |
| --- | --- | --- | --- | --- |
| 1 | 回调里从不执行的断言 | pytest | `unexecuted_assertions`，exit 1，`test_case1.py:3` | `pass`（3/3），exit 0 |
| 2 | 看似合理但错误的期望值（藏在死回调里） | pytest | `unexecuted_assertions`，exit 1，`test_case2.py:3` | 中间态 `pytest_failed`（`assert 2.67 == 2.68`）→ 修正期望后 `pass`（1/1），exit 0 |
| 3 | 回调里从不执行的断言 | JS（V8 coverage） | `unexecuted_assertions`，exit 1，`test_case3.test.js:8` | `pass`（3/3），exit 0 |

## 案例 1 — pytest：从不执行的回调断言

复现前（`on_done` 定义了但从不调用；pytest 本身 2 passed，全绿）：

```python
def test_process_never_calls_back():
    def on_done(value):
        assert value == 42
    # on_done is defined but never called: its assert never executes.
    assert True


def test_normal():
    assert 1 + 1 == 2
```

判定输出（实测，fixture 目录为临时目录，前缀略）：

```
============================== 2 passed in 0.26s ===============================
i6d: unexecuted_assertions (2/3 assertions executed, 1 unexecuted, 0 skipped; pytest exit 0)
  unexecuted: <fixture>/test_case1.py:3: assert value == 42
exit=1
```

证据 JSON（节选）：`verdict: "unexecuted_assertions"`，`total: 3`，`executed: 2`，`unexecuted: [{file: test_case1.py, line: 3, source: "assert value == 42", test: "test_process_never_calls_back"}]`。

复现后（接通回调 `on_done(42)`，其余不动）：

```
============================== 2 passed in 0.27s ===============================
i6d: pass (3/3 assertions executed, 0 unexecuted, 0 skipped; pytest exit 0)
exit=0
```

## 案例 2 — pytest：死回调藏住的错误期望值

`round(2.675, 2)` 在 CPython 里是 `2.67`（2.675 以二进制浮点存储时略低于十进制值），所以 `== 2.68` 看似合理、实为错误期望。复现前（回调从不调用；pytest 本身 1 passed，全绿，错期望值从未被检验）：

```python
def test_rounding_never_checked():
    def on_done():
        assert round(2.675, 2) == 2.68
    # on_done is defined but never called: the plausible-but-wrong
    # expectation (2.68) is never exposed; the test passes green.
```

判定输出（实测）：

```
============================== 1 passed in 0.20s ===============================
i6d: unexecuted_assertions (0/1 assertions executed, 1 unexecuted, 0 skipped; pytest exit 0)
  unexecuted: <fixture>/test_case2.py:3: assert round(2.675, 2) == 2.68
exit=1
```

证据 JSON（节选）：`verdict: "unexecuted_assertions"`，`total: 1`，`executed: 0`，`unexecuted: [{file: test_case2.py, line: 3, source: "assert round(2.675, 2) == 2.68", test: "test_rounding_never_checked"}]`。

中间态（只接通回调 `on_done()`，期望值不动——错期望值随即暴露为普通测试失败）：

```
E       assert 2.67 == 2.68
FAILED test_case2.py::test_rounding_never_checked - assert 2.67 == 2.68
============================== 1 failed in 0.37s ===============================
i6d: pytest_failed (1/1 assertions executed, 0 unexecuted, 0 skipped; pytest exit 1)
exit=1
```

复现后（期望值修正为真实值 `2.67`，回调保持接通）：

```
============================== 1 passed in 0.20s ===============================
i6d: pass (1/1 assertions executed, 0 unexecuted, 0 skipped; pytest exit 0)
exit=0
```

## 案例 3 — JS：从不触发的 EventEmitter 回调断言（V8 coverage）

复现前（`'done'` 从不 emit；node:test 本身全绿）：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

test('callback never runs', () => {
  const emitter = new EventEmitter();
  emitter.on('done', (value) => {
    assert.equal(value, 42);
  });
  // 'done' is never emitted: the assert never executes.
  assert.ok(true);
});

test('normal', () => {
  assert.equal(1 + 1, 2);
});
```

判定输出（实测，JS 门禁独立运行，V8 coverage）：

```
i6d-js: unexecuted_assertions (2/3 assertions executed, 1 unexecuted, 0 skipped; node exit 0)
  unexecuted: <fixture>/test_case3.test.js:8: assert.equal(value, 42)
exit=1
```

证据 JSON（节选）：`verdict: "unexecuted_assertions"`，`total: 3`，`executed: 2`，`unexecuted: [{file: test_case3.test.js, line: 8, source: "assert.equal(value, 42)", test: "callback never runs"}]`。

复现后（补 `emitter.emit('done', 42);`，其余不动）：

```
i6d-js: pass (3/3 assertions executed, 0 unexecuted, 0 skipped; node exit 0)
exit=0
```

## 复现步骤

1. 重跑全部三案（含 RED→GREEN 对照）：`node --test test/i6d-m3-real-cases.test.js`
   （pytest 侧需一个带 pytest 的 Python；无则测试自动建临时 venv 安装 pytest。）
2. 手动复现单案（以案例 1 为例，把上面复现前/后的文件存为 `test_case1.py` 后）：
   ```bash
   python3 xflow/atoms/i6d_assertion_execution.py --root <fixture-dir> \
     --output evidence.json --pytest-python <带 pytest 的 python> -- test_case1.py
   ```
   案例 3（JS 侧）：
   ```bash
   node xflow/atoms/i6d_assertion_execution_js.js --root <fixture-dir> \
     --output evidence.json -- test_case3.test.js
   ```
3. 判定口径：门禁 exit 1 且 `verdict` 为 `unexecuted_assertions`、并点名文件行号与断言原文，即为捕获；exit 0 且 `verdict` 为 `pass`，即为放行。

## 与总单验收的对应关系

- 验收 2（≥3 案例，≥1 死回调、≥1 错期望、≥1 JS、≥1 pytest）：本文件 3 案齐全，判定输出与复现步骤如上；验收本身由主轮裁定，本切片不自行裁定。
- 验收 1、3：门禁核心见切片 1（PR #121）；本切片只补案例证据，不改门禁判定口径。
