"""taksim's Python debugger: runs a script under bdb (the engine under pdb, so no install is needed) and
talks JSON lines to the IDE over a localhost socket (TAKSIM_DBG_PORT, TAKSIM_DBG_TOKEN).

  python pydebug.py <project root> <script> [args...]

IDE -> here: {"cmd": "breakpoints", "breakpoints": {"/abs/file.py": [3, 7]}} · continue · next · step · return · pause · stop
             {"cmd": "frame", "index": n} · {"cmd": "expand", "ref": n} · {"cmd": "evaluate", "expr": "...", "frame": n}   (with "seq")
here -> IDE: {"event": "stopped", "reason", "frames", "variables", "frame"} · {"event": "running"} · {"event": "exited", "code"}
             {"reply": seq, ...} for frame / expand / evaluate
The program's own output goes to the terminal it runs in, as usual.
"""

import bdb
import json
import os
import queue
import reprlib
import socket
import sys
import threading
import traceback
import types

ROOT = os.path.realpath(sys.argv[1])
SCRIPT = os.path.realpath(sys.argv[2])
HERE = os.path.realpath(__file__)

_repr = reprlib.Repr()
_repr.maxstring = 200
_repr.maxother = 200
_repr.maxlist = _repr.maxtuple = _repr.maxdict = _repr.maxset = 20
_repr.maxlevel = 3


class Channel:
    def __init__(self):
        self.sock = socket.create_connection(("127.0.0.1", int(os.environ["TAKSIM_DBG_PORT"])))
        self.out = self.sock.makefile("w", encoding="utf-8")
        self.inbox = queue.Queue()
        self.lock = threading.Lock()
        self.send({"hello": os.environ.get("TAKSIM_DBG_TOKEN", "")})
        threading.Thread(target=self._read, daemon=True).start()

    def send(self, msg):
        with self.lock:
            self.out.write(json.dumps(msg, default=str) + "\n")
            self.out.flush()

    def _read(self):
        for line in self.sock.makefile("r", encoding="utf-8"):
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            # breakpoints and pause take effect while the program runs; the rest waits for a stop
            if msg.get("cmd") == "breakpoints":
                DBG.set_breakpoints(msg.get("breakpoints") or {})
                DBG.ready.set()
            elif msg.get("cmd") == "pause":
                DBG.pause_requested = True
            if msg.get("cmd") not in ("breakpoints", "pause") or DBG.paused:
                self.inbox.put(msg)
        self.inbox.put({"cmd": "stop"})  # the IDE went away


class Debugger(bdb.Bdb):
    def __init__(self):
        super().__init__()
        self.chan = None
        self.paused = False
        self.pause_requested = False
        self.started = False
        self.frames = []  # the stack shown while paused, innermost first
        self.refs = {}
        self.wanted = {}  # file -> lines, as the IDE asked
        self.ready = threading.Event()  # the first breakpoints arrived

    # ---------- breakpoints ----------

    def set_breakpoints(self, by_file):
        self.wanted = {os.path.realpath(f): sorted(set(int(n) for n in lines)) for f, lines in by_file.items()}
        self.clear_all_breaks()
        for f, lines in self.wanted.items():
            for n in lines:
                self.set_break(f, n)  # bdb refuses lines that don't exist; that's fine

    # ---------- what counts as the user's code ----------

    def mine(self, frame):
        f = os.path.realpath(frame.f_code.co_filename)
        return f != HERE and f.startswith(ROOT + os.sep) and "site-packages" not in f

    def stop_here(self, frame):
        if not self.mine(frame):
            return False
        return super().stop_here(frame)

    def set_continue(self):
        # unlike bdb, keep tracing: breakpoints may be added and a pause asked for while it runs
        self._set_stopinfo(self.botframe, None, -1)

    def trace_dispatch(self, frame, event, arg):
        if self.pause_requested and event in ("line", "call") and self.mine(frame):
            self.pause_requested = False
            self.set_step()
        return super().trace_dispatch(frame, event, arg)

    def dispatch_call(self, frame, arg):
        # trace every frame of the user's code, so a pause or a new breakpoint is seen promptly
        if self.mine(frame):
            r = super().dispatch_call(frame, arg)
            return self.trace_dispatch if r is None and not self.quitting else r
        return super().dispatch_call(frame, arg)

    # ---------- stopping ----------

    def at_breakpoint(self, frame):
        return bool(self.get_breaks(self.canonic(frame.f_code.co_filename), frame.f_lineno))

    def user_line(self, frame):
        if not self.started:  # bdb stops on the first line; run to the first breakpoint instead
            self.started = True
            if not self.at_breakpoint(frame):
                self.set_continue()
                return
        self.interact(self.stack_of(frame), "breakpoint" if self.at_breakpoint(frame) else "step")

    def stack_of(self, frame):
        out = []
        while frame is not None:
            if self.mine(frame):
                out.append(frame)
            frame = frame.f_back
        return out

    def interact(self, frames, reason, exception=None):
        self.frames, self.refs, self.paused = frames, {}, True
        self.chan.send({"event": "stopped", "reason": reason, "exception": exception,
                        "frames": [self.describe(f, i) for i, f in enumerate(frames)],
                        "frame": 0, "variables": self.variables(frames[0]) if frames else []})
        try:
            while True:
                msg = self.chan.inbox.get()
                cmd, seq = msg.get("cmd"), msg.get("seq")
                if cmd == "continue":
                    self.set_continue(); break
                if cmd == "next":
                    self.set_next(frames[0]); break
                if cmd == "step":
                    self.set_step(); break
                if cmd == "return":
                    self.set_return(frames[0]); break
                if cmd == "stop":
                    self.set_quit(); break
                if cmd == "frame":
                    i = int(msg.get("index", 0))
                    self.chan.send({"reply": seq, "variables": self.variables(frames[i]) if i < len(frames) else []})
                elif cmd == "expand":
                    self.chan.send({"reply": seq, "variables": self.children(self.refs.get(int(msg.get("ref", -1))))})
                elif cmd == "evaluate":
                    i = int(msg.get("frame", 0))
                    f = frames[i] if i < len(frames) else None
                    try:
                        value = eval(msg.get("expr", ""), f.f_globals if f else {}, f.f_locals if f else {})
                        self.chan.send({"reply": seq, "result": self.var("result", value)})
                    except Exception as e:  # noqa: BLE001 - shown to the user
                        self.chan.send({"reply": seq, "error": f"{type(e).__name__}: {e}"})
                elif seq is not None:
                    self.chan.send({"reply": seq, "error": f"unknown command {cmd}"})
        finally:
            self.paused = False
            self.refs = {}
        if not self.quitting:
            self.chan.send({"event": "running"})

    # ---------- values ----------

    def describe(self, frame, i):
        return {"index": i, "name": frame.f_code.co_name, "file": os.path.realpath(frame.f_code.co_filename),
                "line": frame.f_lineno, "first_line": frame.f_code.co_firstlineno}

    def var(self, name, value):
        try:
            text = _repr.repr(value)
        except Exception as e:  # noqa: BLE001 - a broken __repr__
            text = f"<repr failed: {e}>"
        expandable = isinstance(value, (dict, list, tuple, set, frozenset)) and len(value) > 0 or (
            hasattr(value, "__dict__") and not isinstance(value, type) and not callable(value) and bool(vars(value)))
        ref = None
        if expandable:
            ref = len(self.refs) + 1
            self.refs[ref] = value
        size = len(value) if isinstance(value, (dict, list, tuple, set, frozenset, str)) else None
        return {"name": str(name), "type": type(value).__name__, "value": text, "ref": ref, "size": size}

    def variables(self, frame):
        loc = frame.f_locals
        names = [n for n in loc if not (n.startswith("__") and n.endswith("__"))]
        if frame.f_code.co_name == "<module>":  # module level: the user's names, not imports
            names = [n for n in names if not isinstance(loc[n], type(sys)) and not callable(loc[n]) or isinstance(loc[n], type)]
        return [self.var(n, loc[n]) for n in names[:200]]

    def children(self, value):
        if value is None:
            return []
        if isinstance(value, dict):
            items = list(value.items())[:200]
            return [self.var(_repr.repr(k), v) for k, v in items]
        if isinstance(value, (list, tuple)):
            return [self.var(f"[{i}]", v) for i, v in enumerate(value[:200])]
        if isinstance(value, (set, frozenset)):
            return [self.var("·", v) for v in list(value)[:200]]
        return [self.var(k, v) for k, v in list(vars(value).items())[:200]]


DBG = Debugger()


def main():
    DBG.chan = Channel()
    DBG.ready.wait(10)  # the IDE sends the breakpoints right after the hello
    sys.argv = [SCRIPT] + sys.argv[3:]
    sys.path[0] = os.path.dirname(SCRIPT)
    # the program gets a __main__ of its own (this file is __main__ too, and keeps its globals)
    main_mod = types.ModuleType("__main__")
    main_mod.__dict__.update({"__file__": SCRIPT, "__builtins__": __builtins__})
    sys.modules["__main__"] = main_mod
    with open(SCRIPT, "rb") as f:
        code = compile(f.read(), SCRIPT, "exec")
    code_exit = 0
    try:
        DBG.run(code, main_mod.__dict__)
    except SystemExit as e:
        code_exit = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
    except BaseException as e:  # noqa: BLE001 - an uncaught exception: stop where it happened, like PyCharm
        traceback.print_exc()
        tb, frames = e.__traceback__, []
        while tb is not None:
            frames.insert(0, tb.tb_frame)
            tb = tb.tb_next
        frames = [f for f in frames if DBG.mine(f)]
        if frames:  # (a stop from the IDE ends inside bdb.run, so whatever gets here is the program's)
            sys.settrace(None)
            DBG.quitting = False
            DBG.interact(frames, "exception", f"{type(e).__name__}: {e}")
        code_exit = 1
    finally:
        sys.settrace(None)
    DBG.chan.send({"event": "exited", "code": code_exit})
    sys.stdout.flush()
    os._exit(code_exit)


if __name__ == "__main__":
    main()
