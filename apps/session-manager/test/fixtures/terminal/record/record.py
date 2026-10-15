"""Records real terminal programs into byte-stream fixtures for the emulator golden tests.

Usage (from the repository root):
    python3 -I apps/session-manager/test/fixtures/terminal/record/record.py [scenario ...]

Each scenario runs a program in a fresh PTY (TERM=xterm-256color, 100x30, LANG=C.UTF-8) under
an empty environment and a throwaway HOME, feeds scripted keystrokes, and writes
../<scenario>.json:
    {"name", "cols", "rows", "program", "events": [{"data": <base64>} | {"resize": [c, r]}]}
Nobody answers the program's terminal queries, exactly like a session with no browser attached.
The recording stops while the program is still running (the snapshot is of a live screen).
"""
import base64
import fcntl
import json
import os
import pty
import select
import shutil
import signal
import struct
import sys
import tempfile
import termios
import time

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.dirname(HERE)
COLS, ROWS = 100, 30

SAMPLE = (
    "# termdock golden sample\n"
    "def greet(name: str) -> str:\n"
    "\treturn f'hello {name}'  # tab-indented\n"
    "\n"
    "CJK = '漢字かなカナ한국어'  # wide characters\n"
    "EMOJI = '🙂🚀👍🏽 ok'\n"
    + "".join(f"line {i:03d}: " + "lorem ipsum dolor sit amet " * (1 + i % 5) + "\n" for i in range(120))
)

VIMRC = r"""
set nocompatible
syntax on
set number laststatus=2 ruler
set mouse=a ttymouse=sgr
set title titlestring=termdock-vim
set termguicolors
let &t_SI = "\e[6 q"
let &t_EI = "\e[2 q"
let &t_8f = "\e[38;2;%lu;%lu;%lum"
let &t_8b = "\e[48;2;%lu;%lu;%lum"
set viminfo= noswapfile
"""

BASHRC = r"""
PS1='\[\e[1;32m\]user@termdock\[\e[0m\]:\[\e[1;34m\]~/demo\[\e[0m\]\$ '
"""

HTOPRC = """fields=0 17 18 2 46 47 49 1
hide_userland_threads=1
show_program_path=0
color_scheme=0
delay=5
header_margin=1
tree_view=0
"""


def scenario_steps(name, home):
    with open(os.path.join(home, "sample.py"), "w") as f:
        f.write(SAMPLE)
    sample = "sample.py"  # relative (cwd = home) so no temp path leaks into the screen
    for quiet in (".hushlogin", ".sudo_as_admin_successful"):
        open(os.path.join(home, quiet), "w").close()
    if name == "bash":
        with open(os.path.join(home, ".bashrc"), "w") as f:
            f.write(BASHRC)
        long = "x" * 230
        return ["bash", "--noprofile", "--rcfile", os.path.join(home, ".bashrc"), "-i"], [
            ("wait", 0.8),
            ("send", b"printf '\\e[31mred\\e[0m \\e[1mbold\\e[0m \\e[38;5;208m256\\e[0m \\e[38;2;10;200;90mtrue\\e[0m\\n'\r"),
            ("wait", 0.4),
            ("send", f"echo {long}\r".encode()),
            ("wait", 0.4),
            # 60 colored lines of growing length: scrollback plus wrapped lines.
            ("send", b"for i in $(seq 1 60); do printf '\\e[3%dm%03d\\e[0m %*s|\\n' $((i%8)) $i $((i*7%190)) .; done\r"),
            ("wait", 0.6),
            ("send", b"tabs 4,12,30; printf 'a\\tb\\tc\\td\\n'\r"),
            ("wait", 0.4),
            ("send", b"printf '\\e]2;termdock-bash\\a'; echo '\xe6\xbc\xa2\xe5\xad\x97 \xf0\x9f\x99\x82 end'\r"),
            ("wait", 0.4),
            ("send", b"echo a long command line that keeps going and going past the right edge of the 100 column screen ok"),
            ("wait", 0.4),
        ]
    if name == "vim":
        vimrc = os.path.join(home, "vimrc")
        with open(vimrc, "w") as f:
            f.write(VIMRC)
        return ["vim", "-u", vimrc, "-i", "NONE", "-N", sample], [
            ("wait", 1.5),
            ("send", b"\x04"),  # Ctrl-D: scroll half a page (scroll region)
            ("wait", 0.4),
            ("send", b"\x05\x05\x05"),  # Ctrl-E: scroll lines
            ("wait", 0.4),
            ("resize", 90, 26),
            ("wait", 0.6),
            ("send", b"gg4jM"),  # cursor to the middle of the window
            ("wait", 0.4),
            ("send", b"A edited \xe6\xbc\xa2\xe5\xad\x97"),  # insert mode: bar cursor stays active
            ("wait", 0.5),
        ]
    if name == "htop":
        cfg = os.path.join(home, ".config", "htop")
        os.makedirs(cfg)
        with open(os.path.join(cfg, "htoprc"), "w") as f:
            f.write(HTOPRC)
        return ["sh", "-c", "sleep 300 & exec htop -p $!"], [
            ("wait", 2.5),
            ("send", b"\x1b[B"),
            ("wait", 1.0),
        ]
    if name == "less":
        return ["less", "-R", sample], [
            ("wait", 0.8),
            ("send", b" "),
            ("wait", 0.3),
            ("send", b"/ipsum\r"),
            ("wait", 0.4),
            ("send", b"5j"),
            ("wait", 0.4),
        ]
    raise SystemExit(f"unknown scenario {name}")


def set_size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def drain(fd, events, seconds):
    end = time.monotonic() + seconds
    while True:
        left = end - time.monotonic()
        if left <= 0:
            return
        r, _, _ = select.select([fd], [], [], left)
        if not r:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            return
        if not chunk:
            return
        if events and "data" in events[-1]:
            events[-1]["data"] += chunk
        else:
            events.append({"data": chunk})


def record(name):
    home = tempfile.mkdtemp(prefix="termdock-rec-")
    try:
        argv, steps = scenario_steps(name, home)
        env = {
            "HOME": home,
            "TERM": "xterm-256color",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "PATH": "/usr/bin:/bin",
            "XDG_CONFIG_HOME": os.path.join(home, ".config"),
        }
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(home)
            set_size(sys.stdout.fileno(), COLS, ROWS)
            os.execvpe(argv[0], argv, env)
        set_size(fd, COLS, ROWS)
        events = []
        for step in steps:
            if step[0] == "wait":
                drain(fd, events, step[1])
            elif step[0] == "send":
                os.write(fd, step[1])
            elif step[0] == "resize":
                drain(fd, events, 0.05)
                events.append({"resize": [step[1], step[2]]})
                set_size(fd, step[1], step[2])
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        os.close(fd)
    finally:
        shutil.rmtree(home, ignore_errors=True)
    out = {
        "name": name,
        "cols": COLS,
        "rows": ROWS,
        "program": " ".join(argv[:1]),
        "events": [
            {"data": base64.b64encode(e["data"]).decode()} if "data" in e else e for e in events
        ],
    }
    path = os.path.join(OUT_DIR, f"{name}.json")
    with open(path, "w") as f:
        json.dump(out, f, indent=1)
        f.write("\n")
    size = sum(len(e["data"]) for e in events if "data" in e)
    print(f"{name}: {size} bytes -> {path}")


if __name__ == "__main__":
    for scenario in sys.argv[1:] or ["bash", "vim", "htop", "less"]:
        record(scenario)
