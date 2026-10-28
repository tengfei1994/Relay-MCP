"""Real, user-owned SSH/Git fixture. No application Job/Deployment rows are seeded.
Only runs beneath the approved nonproduction root and binds loopback ports.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = '/home/ftd/relay-knowledge-engine-nonprod'
FIXTURE = ROOT + '/opsfixture'
CHECKOUT = FIXTURE + '/checkout'
RESTART = "if command -v pm2 >/dev/null 2>&1; then pm2 restart all; elif [ -f docker-compose.yml ] || [ -f compose.yml ]; then docker compose up -d --build; else echo 'No PM2 or Docker workload found'; fi"
REPO_COMMANDS = {'git rev-parse HEAD', 'git fetch origin', "git checkout 'main'", "git checkout 'fixture-missing-branch'", "git pull --ff-only origin 'main'", RESTART}
CONTROL_COMMANDS = {'relay-fixture ' + verb for verb in ['verify', 'fail', 'start', 'stop', 'restart']}

def allowed_command(command, pinned_commits=()):
    if command in CONTROL_COMMANDS or command in {'git rev-parse HEAD', 'echo ok'}: return True
    if command == "mkdir -p -- '" + CHECKOUT + "'": return True
    prefix = "cd -- '" + CHECKOUT + "' && "
    if not command.startswith(prefix): return False
    tail = command[len(prefix):]
    if tail in REPO_COMMANDS: return True
    match = re.fullmatch(r"git reset --hard '([0-9a-f]{40})'", tail)
    return bool(match and match.group(1) in pinned_commits)

def private_json(path, value):
    tmp = str(path) + '.tmp'
    with open(tmp, 'w') as f: json.dump(value, f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)

def guard():
    if sys.platform != 'linux' or os.environ.get('RELAY_E2E_ISOLATED') != '1': raise RuntimeError('isolated_nonproduction_required')
    if Path(FIXTURE).resolve() != Path(FIXTURE): raise RuntimeError('fixture_symlink_denied')

def run(args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, stderr=subprocess.DEVNULL, text=True).strip()

def setup():
    guard()
    p = Path(FIXTURE); p.mkdir(mode=0o700, exist_ok=True)
    if (p/'transport.json').exists():
        print(json.dumps({'status':'already_prepared','metadata':str(p/'transport.json')})); return
    with socket.socket() as sock: sock.bind(('127.0.0.1',18322))
    for name in ['bin','home','origin','seed','checkout']: (p/name).mkdir(mode=0o700,exist_ok=True)
    for command in ['git','mkdir']:
        dest=p/'bin'/command
        if not dest.exists(): dest.symlink_to('/usr/bin/'+command)
    # Distinct fixture keys; never reads or changes the host's authorized_keys.
    for key in ['hostkey','probe-key']:
        run(['/usr/bin/ssh-keygen','-q','-t','ed25519','-N','','-f',str(p/key)])
    shutil.copyfile(p/'probe-key.pub',p/'authorized_keys'); os.chmod(p/'authorized_keys',0o600)
    shutil.copyfile(__file__,p/'runner.py'); os.chmod(p/'runner.py',0o700)
    (p/'command-wrapper').write_text('#!/bin/sh\nexport RELAY_E2E_ISOLATED=1\nexec /usr/bin/python3 '+str(p/'runner.py')+' ssh\n'); os.chmod(p/'command-wrapper',0o700)
    (p/'bin'/'relay-fixture').write_text('#!/bin/sh\nexport RELAY_E2E_ISOLATED=1\nexec /usr/bin/python3 '+str(p/'runner.py')+' control "$@"\n'); os.chmod(p/'bin'/'relay-fixture',0o700)
    git=['/usr/bin/git']; seed=str(p/'seed'); origin=str(p/'origin')
    run(git+['init','--bare','--initial-branch=main',origin]); run(git+['init','--initial-branch=main',seed])
    run(git+['config','user.name','Relay Isolated Acceptance'],seed); run(git+['config','user.email','fixture@localhost.invalid'],seed)
    (p/'seed'/'version.txt').write_text('isolated fixture version one\n')
    run(git+['add','version.txt'],seed);run(git+['commit','-m','Fixture initial revision'],seed)
    initial=run(git+['rev-parse','HEAD'],seed);run(git+['remote','add','origin',origin],seed);run(git+['push','-u','origin','main'],seed)
    run(git+['clone',origin,CHECKOUT]);(p/'seed'/'version.txt').write_text('isolated fixture version two\n')
    run(git+['add','version.txt'],seed);run(git+['commit','-m','Fixture next revision'],seed);latest=run(git+['rev-parse','HEAD'],seed);run(git+['push','origin','main'],seed)
    private_json(p/'transport.json',{'schemaVersion':1,'host':'127.0.0.1','port':18322,'user':'ftd','checkout':CHECKOUT,'initialCommit':initial,'latestCommit':latest,'fixtureServicePort':18323,'realGit':True,'realSSH':True,'fixtureNotProduction':True})
    config='\n'.join(['Port 18322','ListenAddress 127.0.0.1','HostKey '+str(p/'hostkey'),'PidFile '+str(p/'sshd.pid'),'AuthorizedKeysFile '+str(p/'authorized_keys'),'PasswordAuthentication no','KbdInteractiveAuthentication no','UsePAM no','PubkeyAuthentication yes','StrictModes yes','AllowUsers ftd','PermitRootLogin no','PermitTTY no','PermitUserRC no','DisableForwarding yes','ForceCommand '+str(p/'command-wrapper'),'LogLevel ERROR'])+'\n'
    (p/'sshd.conf').write_text(config);os.chmod(p/'sshd.conf',0o600)
    run(['/usr/sbin/sshd','-t','-f',str(p/'sshd.conf')])
    log=open(p/'sshd.log','ab',buffering=0); os.chmod(p/'sshd.log',0o600)
    child=subprocess.Popen(['/usr/sbin/sshd','-D','-e','-f',str(p/'sshd.conf')],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
    time.sleep(.4)
    if child.poll() is not None: raise RuntimeError('fixture_sshd_failed')
    private_json(p/'sshd-process.json',{'pid':child.pid,'root':FIXTURE})
    result=run(['/usr/bin/ssh','-F','/dev/null','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=accept-new','-o','UserKnownHostsFile='+str(p/'known_hosts'),'-i',str(p/'probe-key'),'-p','18322','ftd@127.0.0.1','git rev-parse HEAD'])
    if result!=initial: raise RuntimeError('fixture_ssh_probe_mismatch')
    print(json.dumps({'status':'prepared','sshdPid':child.pid,'port':18322,'initialCommit':initial,'latestCommit':latest,'actualSSHProbe':True}))

def ssh_command():
    guard(); info=json.loads(Path(FIXTURE+'/transport.json').read_text()); command=os.environ.get('SSH_ORIGINAL_COMMAND','')
    if not allowed_command(command,[info['initialCommit'],info['latestCommit']]):
        print('fixture command denied',file=sys.stderr); return 126
    with open(FIXTURE+'/executions.jsonl','a') as f: f.write(json.dumps({'at':time.time(),'commandSha256':hashlib.sha256(command.encode()).hexdigest(),'kind':'control' if command in CONTROL_COMMANDS else 'git-or-setup'})+'\n')
    os.environ.update({'PATH':FIXTURE+'/bin','HOME':FIXTURE+'/home','GIT_CONFIG_NOSYSTEM':'1','GIT_TERMINAL_PROMPT':'0'});os.chdir(CHECKOUT)
    os.execv('/bin/sh',['sh','-c',command])

def control(verb):
    guard(); p=Path(FIXTURE); state=p/'service.json'
    if verb=='fail': print('intentional isolated fixture exit 17',file=sys.stderr);return 17
    if verb=='verify':
        print(json.dumps({'commit':run(['/usr/bin/git','rev-parse','HEAD'],CHECKOUT),'versionSha256':hashlib.sha256((Path(CHECKOUT)/'version.txt').read_bytes()).hexdigest()}));return 0
    if verb in ['stop','restart'] and state.exists():
        prior=json.loads(state.read_text());pid=prior['pid'];cmd=Path('/proc/'+str(pid)+'/cmdline')
        if cmd.exists():
            args=cmd.read_bytes()
            if b'http.server' not in args or b'18323' not in args:raise RuntimeError('fixture_service_owner_mismatch')
            os.kill(pid,signal.SIGTERM)
        state.unlink()
    if verb in ['start','restart']:
        if state.exists(): raise RuntimeError('fixture_service_already_started')
        log=open(p/'service.log','ab');os.chmod(p/'service.log',0o600)
        child=subprocess.Popen(['/usr/bin/python3','-m','http.server','18323','--bind','127.0.0.1','--directory',CHECKOUT],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
        private_json(state,{'pid':child.pid,'port':18323});time.sleep(.25)
        with urllib.request.urlopen('http://127.0.0.1:18323/version.txt',timeout=3) as response: data=response.read()
        print(json.dumps({'status':'started','pid':child.pid,'bodySha256':hashlib.sha256(data).hexdigest()}));return 0
    print(json.dumps({'status':'stopped'}));return 0

if __name__=='__main__':
    try:
        mode=sys.argv[1]
        if mode=='setup':setup()
        elif mode=='ssh':sys.exit(ssh_command())
        elif mode=='control' and sys.argv[2] in ['verify','fail','start','stop','restart']:sys.exit(control(sys.argv[2]))
        else:raise RuntimeError('unsupported_mode')
    except Exception as error:
        print(json.dumps({'status':'failed','errorClass':type(error).__name__}));sys.exit(1)
