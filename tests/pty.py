"""Dev-only: run `bun scripts/plugin.ts <verb>` in a pty, feeding keys. Usage: python3 -I tests/pty.py <verb> <keys...>"""
import pty, os, time, select, threading, re, sys
verb = sys.argv[1]; keys = [k.encode().decode('unicode_escape').encode() for k in sys.argv[2:]]
pid, fd = pty.fork()
if pid == 0:
    os.execvp("bun", ["bun", "scripts/plugin.ts", verb])
out=[]
def reader():
    while True:
        r,_,_=select.select([fd],[],[],4)
        if not r: break
        try: d=os.read(fd,4096)
        except OSError: break
        if not d: break
        out.append(d)
t=threading.Thread(target=reader); t.start()
time.sleep(2.0)
try:
    for s in keys:
        time.sleep(0.5); os.write(fd, s)
except OSError as e:
    print("write failed:", e)
t.join()
import signal
for _ in range(50):
    p2, status = os.waitpid(pid, os.WNOHANG)
    if p2: break
    time.sleep(0.2)
else:
    os.kill(pid, signal.SIGKILL); _, status = os.waitpid(pid, 0); print("KILLED: child did not exit")
raw=b"".join(out).decode(errors="replace")
plain=re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", raw)
print("exit:", os.waitstatus_to_exitcode(status))
print(plain[-700:])
