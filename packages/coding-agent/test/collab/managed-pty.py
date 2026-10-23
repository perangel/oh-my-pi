#!/usr/bin/env python3
"""Real native input/transport contract test. No model credentials, mocked forwarding or external relay."""
import argparse, base64, codecs, fcntl, json, os, pathlib, pty, select, shutil, signal, struct, subprocess, tempfile, termios, time
import pyte

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[3]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--bun', default=shutil.which('bun'), help='Bun executable (>=1.4)')
args = parser.parse_args()
if not args.bun:
    parser.error('Bun is required; pass --bun')
BUN = pathlib.Path(args.bun).resolve()
children, terminals, checks = [], [], []
report = {'checks': checks, 'screens': []}

def check(name, condition):
    checks.append({'name': name, 'passed': bool(condition)})
    if not condition:
        raise AssertionError(name)

with tempfile.TemporaryDirectory(prefix='.managed-pty-', dir=HERE) as tmp:
    base = pathlib.Path(tmp)
    os.chmod(base, 0o700)
    def environment(name, role):
        d = base / name
        d.mkdir()
        for child in ['home', 'agent', 'cwd', 'tmp']:
            (d / child).mkdir()
        env = {'PATH': f'{BUN.parent}:/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(d/'home'),
               'TMPDIR': str(d/'tmp'), 'PI_CODING_AGENT_DIR': str(d/'agent'), 'PI_NO_TITLE': '1',
               'TERM': 'xterm-256color', 'LANG': 'en_US.UTF-8', 'GIT_CONFIG_NOSYSTEM': '1',
               'GIT_CONFIG_GLOBAL': '/dev/null', 'FIXTURE_DIR': str(d), 'FIXTURE_ROLE': role,
               'XDG_CONFIG_HOME': str(d/'home/config'), 'XDG_CACHE_HOME': str(d/'home/cache'),
               'XDG_DATA_HOME': str(d/'home/data')}
        subprocess.run(['/usr/bin/git', 'init', '--quiet', str(d/'cwd')], env=env, check=True)
        if role == 'guest':
            project = d/'cwd/.omp'
            (project/'extensions').mkdir(parents=True)
            (project/'config.yml').write_text('spelling:\n  autocomplete: auto\n  autocorrect: true\ncollab:\n  autoStart: control\n  relayUrl: ws://127.0.0.1:1\n')
            (d/'agent/models.yml').write_text('providers: [invalid fixture config')
            (project/'extensions/forbidden.ts').write_text('throw new Error("ambient extension loaded");\n')
        return d, env

    class Terminal:
        def __init__(self, name, role, capability=None, reopen=None, init_gate=False):
            self.d, env = environment(name, role)
            self.name = name
            env['RELAY_URL'] = url
            if init_gate:
                env['FIXTURE_INIT_GATE'] = '1'
            if reopen:
                env['REOPEN_JOURNAL'] = reopen
            self.master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 55, 160, 0, 0))
            self.slave_audit = os.dup(slave)
            self.initial_termios = termios.tcgetattr(slave)
            self.screen = pyte.Screen(160, 55)
            self.stream = pyte.Stream(self.screen)
            self.decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
            self.raw = ''
            read_fd, write_fd = os.pipe()
            env['FIXTURE_FD'] = str(read_fd)
            self.proc = subprocess.Popen([str(BUN), str(HERE/'helpers/managed-native.ts')],
                env=env, cwd=self.d/'cwd', stdin=slave, stdout=slave, stderr=slave,
                start_new_session=True, pass_fds=(read_fd,))
            children.append(self.proc)
            terminals.append(self)
            os.close(slave)
            os.close(read_fd)
            if capability:
                os.write(write_fd, json.dumps(capability).encode())
            os.close(write_fd)
        def drain(self):
            while select.select([self.master], [], [], 0)[0]:
                try:
                    data = os.read(self.master, 65536)
                except OSError:
                    break
                if not data:
                    break
                text = self.decoder.decode(data)
                self.raw = (self.raw + text)[-120000:]
                self.stream.feed(text)
                if '\x1b[6n' in text:
                    os.write(self.master, b'\x1b[1;1R')
        def send(self, text):
            os.write(self.master, text.encode())
        def events(self):
            try:
                return [json.loads(line) for line in (self.d/'events.jsonl').read_text().splitlines()]
            except FileNotFoundError:
                return []
        def snapshot(self):
            try:
                return json.loads((self.d/'snapshot.json').read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                return {}
        def command(self, value):
            (self.d/'command.json').write_text(json.dumps(value))
        def screen_text(self):
            self.drain()
            return '\n'.join(self.screen.display)
        def capture(self):
            report['screens'].append({'terminal': self.name, 'screen': self.screen_text()})

        def terminal_restored(self):
            return termios.tcgetattr(self.slave_audit) == self.initial_termios
    def pump(seconds=.1):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            for terminal in terminals:
                terminal.drain()
            time.sleep(.02)
    def wait(predicate, message, timeout=20):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if predicate():
                return
            pump()
        raise AssertionError(message)
    def ready(terminal):
        wait(lambda: any(e.get('type') == 'ready' for e in terminal.events()) or terminal.proc.poll() is not None, terminal.name+' readiness')
        if terminal.proc.poll() is not None:
            raise AssertionError(terminal.name+' startup: '+str(terminal.events())+'\n'+terminal.screen_text())
    def settled(host, count):
        wait(lambda: sum(e.get('type') == 'settled' for e in host.events()) >= count, 'settlement')
        pump(.3)
    def transcript(terminal):
        return [e['id'] for e in terminal.snapshot().get('entries', []) if e['type'] in ['message', 'custom_message']]

    url = None
    try:
        signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError('native test deadline')))
        signal.alarm(210)
        relay_dir, relay_env = environment('relay', 'relay')
        relay = subprocess.Popen([str(BUN), str(HERE/'helpers/managed-relay.ts')], env=relay_env,
            cwd=relay_dir/'cwd', stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        children.append(relay)
        if not select.select([relay.stdout], [], [], 10)[0]:
            raise AssertionError('relay readiness')
        url = relay.stdout.readline().strip()
        check('relay is loopback', url.startswith('ws://127.0.0.1:'))
        report['listener'] = subprocess.run(['/usr/sbin/lsof', '-nP', '-a', '-p', str(relay.pid), '-iTCP', '-sTCP:LISTEN'], capture_output=True, text=True).stdout
        lazy = Terminal('lazy-host', 'lazy-host'); ready(lazy)
        local_identity = next(e['identity'] for e in lazy.events() if e.get('type') == 'ready')
        check('local native readiness needs no relay room', local_identity['generation'] == 0 and not (lazy.d/'capability.json').exists())
        lazy.send('/collab start '+url+'\r')
        wait(lambda: 'Managed controller cannot start' in lazy.screen_text(), 'unbound room command denied before first managed room')
        lazy.command({'local': {'requestId': 'inline-first', 'text': 'INLINE_WITHOUT_RELAY'}})
        settled(lazy, 1)
        check('inline admission writes a real native settlement without a room',
              next(e['receipt'] for e in lazy.events() if e.get('type') == 'settled')['phase'] == 'completed')
        lazy.command({'room': 'ws://127.0.0.1:1'})
        wait(lambda: any(e.get('type') == 'room-failed' for e in lazy.events()), 'unreachable lazy room failure', 25)
        lazy.command({'local': {'requestId': 'inline-after-failure', 'text': 'INLINE_AFTER_RELAY_FAILURE'}})
        settled(lazy, 2)
        check('relay connection failure preserves local admission and native lifecycle',
              lazy.proc.poll() is None and sum(e.get('type') == 'inference' for e in lazy.events()) == 2)
        lazy.command({'room': url, 'coalesce': True})
        wait(lambda: (lazy.d/'capability.json').exists(), 'lazy room publication')
        lazy_cap = json.loads((lazy.d/'capability.json').read_text())
        lazy_guest = Terminal('lazy-guest', 'guest', lazy_cap); ready(lazy_guest)
        wait(lambda: transcript(lazy_guest) == transcript(lazy), 'inline journal snapshot to native guest')
        check('lazy room coalesces and retains native session identity',
              any(e.get('type') == 'room-start-coalesced' and e.get('same') for e in lazy.events())
              and lazy_cap['expected']['sessionId'] == local_identity['sessionId']
              and lazy_cap['expected']['instanceId'] == local_identity['instanceId']
              and lazy_cap['expected']['generation'] > 0)
        lazy_guest.command({'resubmit': {'requestId': 'inline-first', 'text': 'INLINE_WITHOUT_RELAY', 'expected': lazy_cap['expected']}})
        wait(lambda: any(e.get('receipt', {}).get('requestId') == 'inline-first' for e in lazy_guest.events()), 'guest lookup of inline receipt')
        check('guest retry of inline request never repeats inference', sum(e.get('type') == 'inference' for e in lazy.events()) == 2)
        lazy.command({'local': {'requestId': 'inline-active', 'text': 'INLINE_ACTIVE'}})
        wait(lambda: sum(e.get('type') == 'inference' for e in lazy.events()) == 3, 'local turn running')
        lazy_guest.send('GUEST_DURING_LOCAL\r')
        wait(lambda: any(e.get('receipt', {}).get('code') == 'busy' for e in lazy_guest.events()), 'guest blocked by inline turn')
        settled(lazy, 3)
        lazy_guest.send('GUEST_ACTIVE\r')
        wait(lambda: sum(e.get('type') == 'inference' for e in lazy.events()) == 4, 'guest turn running')
        lazy.command({'local': {'requestId': 'local-during-guest', 'text': 'LOCAL_DURING_GUEST'}})
        wait(lambda: any(e.get('type') == 'local-receipt' and e['receipt'].get('code') == 'busy' for e in lazy.events()), 'inline blocked by guest turn')
        settled(lazy, 4)
        check('inline and guest share one active-turn reservation', sum(e.get('type') == 'inference' for e in lazy.events()) == 4)
        lazy.command({'roomStop': True})
        wait(lambda: lazy_guest.proc.poll() is not None and any(e.get('type') == 'room-stopped' for e in lazy.events()), 'room-only detach')
        lazy.command({'local': {'requestId': 'inline-after-detach', 'text': 'INLINE_AFTER_ROOM_DETACH'}})
        settled(lazy, 5)
        lazy.command({'room': url})
        wait(lambda: sum(e.get('type') == 'room-ready' for e in lazy.events()) == 2, 'replacement room')
        new_cap = json.loads((lazy.d/'capability.json').read_text())
        new_guest = Terminal('lazy-reentered-guest', 'guest', new_cap); ready(new_guest)
        wait(lambda: transcript(new_guest) == transcript(lazy), 'same-journal room reentry')
        check('room teardown preserves inline admission and reentry uses a fresh native generation',
              new_cap['expected']['generation'] > lazy_cap['expected']['generation']
              and new_cap['expected']['sessionId'] == local_identity['sessionId']
              and sum(e.get('type') == 'inference' for e in lazy.events()) == 5)
        lazy.capture(); new_guest.capture()
        lazy.command({'stop': True})
        wait(lambda: lazy.proc.poll() is not None and new_guest.proc.poll() is not None, 'lazy native lifecycle cleanup')
        check('lazy native stop restores terminal after local and guest work', lazy.proc.returncode == 0 and lazy.terminal_restored())
        draft_host = Terminal('draft-host', 'host'); ready(draft_host)
        draft_cap = json.loads((draft_host.d/'capability.json').read_text())
        draft_guest = Terminal('draft-guest', 'guest', draft_cap); ready(draft_guest)
        draft_guest.send('DELAYED_NATIVE_INPUT\r')
        wait(lambda: any(e.get('request', {}).get('text') == 'DELAYED_NATIVE_INPUT' for e in draft_guest.events()), 'delayed outbox persistence')
        draft_guest.send('NEXT_DRAFT_SURVIVES')
        wait(lambda: 'NEXT_DRAFT_SURVIVES' in draft_guest.screen_text(), 'next draft entered during persistence')
        (draft_guest.d/'outbox-release').write_text('1')
        settled(draft_host, 1)
        check('next draft survives completion of previous outbox persistence', 'NEXT_DRAFT_SURVIVES' in draft_guest.screen_text())
        check('next draft remains unsubmitted', sum(e.get('type') == 'inference' for e in draft_host.events()) == 1)
        draft_host.command({'stop': True})
        wait(lambda: draft_host.proc.poll() is not None and draft_guest.proc.poll() is not None, 'draft regression cleanup')
        for shutdown_signal in [signal.SIGTERM, signal.SIGINT, signal.SIGHUP]:
            signal_host = Terminal('signal-host-'+str(shutdown_signal), 'host'); ready(signal_host)
            signal_cap = json.loads((signal_host.d/'capability.json').read_text())
            signal_guest = Terminal('signal-guest-'+str(shutdown_signal), 'guest', signal_cap); ready(signal_guest)
            (signal_host.d/'settlement-block').write_text('1')
            signal_guest.send('PERSIST_BEFORE_SIGNAL_EXIT\r')
            wait(lambda: any(e.get('type') == 'settlement-wait' for e in signal_host.events()), 'settlement persistence gate')
            os.killpg(signal_host.proc.pid, shutdown_signal)
            pump(.3)
            check('signal '+str(shutdown_signal)+' waits for settlement before disposal',
                  signal_host.proc.poll() is None and not any(e.get('type') == 'dispose-enter' for e in signal_host.events()))
            # A second signal must not hand control back to generic postmortem
            # cleanup while the embedding's settlement callback is pending.
            os.killpg(signal_host.proc.pid, shutdown_signal)
            pump(.2)
            check('repeated signal '+str(shutdown_signal)+' retains settlement ownership',
                  signal_host.proc.poll() is None and not any(e.get('type') == 'dispose-enter' for e in signal_host.events()))
            (signal_host.d/'settlement-release').write_text('1')
            wait(lambda: signal_host.proc.poll() is not None and signal_guest.proc.poll() is not None, 'signal settlement and shutdown')
            events = [e.get('type') for e in signal_host.events()]
            check('signal '+str(shutdown_signal)+' settles then restores terminal and exits',
                  'settled' in events and 'dispose-enter' in events and events.index('settled') < events.index('dispose-enter')
                  and signal_host.proc.returncode == 128 + shutdown_signal and signal_host.terminal_restored())
        for starting_role in ['host', 'guest']:
            starting = Terminal('starting-'+starting_role, starting_role,
                draft_cap if starting_role == 'guest' else None, init_gate=True)
            wait(lambda: any(e.get('type') == 'init-wait' for e in starting.events()), 'native initialization gate')
            os.killpg(starting.proc.pid, signal.SIGTERM)
            pump(.3)
            check(starting_role+' signal retains initialization ownership',
                  starting.proc.poll() is None and not any(e.get('type') == 'dispose-enter' for e in starting.events()))
            (starting.d/'init-release').write_text('1')
            wait(lambda: starting.proc.poll() is not None, 'initialization shutdown')
            check(starting_role+' cannot restart terminal or publish after startup stop',
                  starting.terminal_restored() and not any(e.get('type') == 'ready' for e in starting.events()))
        host = Terminal('host', 'host')
        ready(host)
        cap = json.loads((host.d/'capability.json').read_text())
        g1, g2 = Terminal('guest1', 'guest', cap), Terminal('guest2', 'guest', cap)
        ready(g1); ready(g2)
        pump(.5)
        check('two native replicas share canonical session', g1.snapshot()['id'] == g2.snapshot()['id'] == cap['expected']['sessionId'])
        check('immutable scope visible', all('FACTORY fixture' in g.screen_text() for g in [g1, g2]))
        check('bound replicas expose no local tools', all(g.snapshot()['tools'] == [] for g in [g1, g2]))
        g1.send('FIRST_NATIVE_INPUT\r')
        wait(lambda: any(e.get('type') == 'inference' for e in host.events()), 'native input execution')
        g2.send('BUSY_REJECTED_INPUT\r')
        wait(lambda: any(e.get('receipt', {}).get('code') == 'busy' for e in g2.events()), 'busy receipt')
        settled(host, 1)
        entries = host.snapshot()['entries']
        check('busy rejected without append or execution', not any(e.get('content') == 'BUSY_REJECTED_INPUT' for e in entries) and sum(e.get('type') == 'inference' for e in host.events()) == 1)
        check('native completion rendered on both guests', all('NATIVE-1 streaming complete.' in g.screen_text() for g in [g1, g2]))
        check('native transcript IDs converge', transcript(host) == transcript(g1) == transcript(g2))
        first = next(e['request'] for e in g1.events() if e.get('type') == 'outbox')
        receipt = next(e['receipt'] for e in host.events() if e.get('type') == 'settled')
        check('request correlated to persisted native entries', receipt['requestId'] == first['requestId'] and receipt['entryIds'] and receipt['settlementEntryId'])
        check('live native events carry the same opaque request and turn', any(
            e.get('event') == 'message_end' and e.get('turn', {}).get('requestId') == first['requestId']
            and e.get('turn', {}).get('turnId') == receipt['turnId'] for e in g1.events()))
        g1.send('POLICY_REJECT\r')
        wait(lambda: any(e.get('receipt', {}).get('code') == 'fixture-denied' for e in g1.events()), 'policy rejection')
        check('embedder denial precedes append and execution', not any(
            e.get('content') == 'POLICY_REJECT' for e in host.snapshot()['entries'])
            and sum(e.get('type') == 'inference' for e in host.events()) == 1)
        g1.send('\x15')
        raw = Terminal('raw', 'raw', cap); ready(raw)
        raw.command({'t': 'managed-prompt', 'request': first})
        wait(lambda: any(e.get('t') == 'managed-receipt' for e in raw.events()), 'duplicate receipt')
        check('duplicate routes to receipt lookup without execution', sum(e.get('type') == 'lookup' and e.get('requestId') == first['requestId'] for e in host.events()) >= 2 and sum(e.get('type') == 'inference' for e in host.events()) == 1)
        raw.command({'t': 'managed-prompt', 'request': {**first, 'text': 'CHANGED_PAYLOAD'}})
        wait(lambda: any(e.get('receipt', {}).get('code') == 'request-conflict' for e in raw.events()), 'same-ID payload conflict')
        raw.command({'t': 'managed-lookup', 'requestId': first['requestId'], 'expected': {**cap['expected'], 'hostEpoch': 'stale'}})
        wait(lambda: any(e.get('receipt', {}).get('code') == 'binding-mismatch' for e in raw.events()), 'stale request binding')
        raw.command({'t': 'managed-prompt', 'request': {**first, 'requestId': 'malformed-text', 'text': {}}})
        wait(lambda: any(e.get('receipt', {}).get('requestId') == 'malformed-text' and e['receipt'].get('code') == 'invalid-request' for e in raw.events()), 'typed text boundary')
        raw.command({'t': 'managed-cancel', 'requestId': 'malformed-target', 'turnId': {}, 'expected': cap['expected']})
        wait(lambda: any(e.get('receipt', {}).get('requestId') == 'malformed-target' and e['receipt'].get('code') == 'invalid-request' for e in raw.events()), 'typed cancellation boundary')
        raw.command({'t': 'managed-lookup', 'requestId': 7, 'expected': cap['expected']})
        wait(lambda: any(e.get('message') == 'Invalid managed request identity' for e in raw.events()), 'typed lookup boundary')
        check('malformed wire fields never reach typed policy callbacks', not any(e.get('requestId') in ['malformed-text', 'malformed-target', 7] for e in host.events()))
        g1.send('SECOND_NATIVE_INPUT\r')
        wait(lambda: sum(e.get('type') == 'inference' for e in host.events()) == 2, 'second native input')
        raw.command({'t': 'managed-cancel', 'requestId': first['requestId'], 'turnId': receipt['turnId'], 'expected': cap['expected']})
        wait(lambda: any(e.get('receipt', {}).get('code') == 'stale-turn' for e in raw.events()), 'stale cancel receipt')
        settled(host, 2)
        check('stale cancellation cannot abort successor', not any(e.get('type') == 'aborted' for e in host.events()))
        g1.send('CANCEL_TARGETED_NATIVE_INPUT\r')
        wait(lambda: sum(e.get('type') == 'inference' for e in host.events()) == 3, 'cancel input')
        pump(.3)
        g2.send('\x1b')
        settled(host, 3)
        check('native peer Esc cancels only the displayed authorized turn', any(e.get('type') == 'aborted' for e in host.events()))
        for frame in [{'t': 'abort'}, {'t': 'prompt', 'text': 'RAW_FORBIDDEN'},
                      {'t': 'agent-cmd', 'cmd': 'kill', 'agentId': 'Main'},
                      {'t': 'fetch-transcript', 'reqId': 42, 'agentId': 'Main', 'fromByte': 0},
                      {'t': 'ui-response', 'reqId': 42, 'value': 'yes'}]:
            before = sum(e.get('t') == 'error' for e in raw.events())
            raw.command(frame)
            wait(lambda: sum(e.get('t') == 'error' for e in raw.events()) > before, 'remote action denial')
        check('all raw remote action paths denied', not any(e.get('content') == 'RAW_FORBIDDEN' for e in host.snapshot()['entries']))
        g1.command({'localProbe': True})
        wait(lambda: any(e.get('type') == 'local-denied' for e in g1.events()), 'replica execution latch')
        for command in ['/new\r', '!touch FORBIDDEN\r', '/join elsewhere\r']:
            g1.send(command); pump(.2)
        check('bound local commands cannot switch scope', g1.snapshot()['id'] == cap['expected']['sessionId'])
        g1.send('\x15UNSENT_DURING_RECONNECT\r')
        wait(lambda: any(e.get('request', {}).get('text') == 'UNSENT_DURING_RECONNECT' for e in g1.events()), 'outbox persistence')
        os.kill(relay.pid, signal.SIGUSR1)
        pump(1.8)
        wait(lambda: all(sum(e.get('type') == 'snapshot-ready' for e in g.events()) >= 2 and g.snapshot().get('connected') for g in [g1, g2]), 'complete reconnect snapshots')
        check('native reconnect resnapshot retains canonical IDs', transcript(host) == transcript(g1) == transcript(g2))
        (g1.d/'outbox-release').write_text('1')
        pump(.5)
        unsent = next(e['request'] for e in g1.events() if e.get('request', {}).get('text') == 'UNSENT_DURING_RECONNECT')
        g1.command({'lookup': unsent['requestId']})
        wait(lambda: any(e.get('receipt', {}).get('requestId') == unsent['requestId'] and e['receipt']['phase'] == 'unknown' for e in g1.events()), 'unknown outbox receipt')
        check('disconnect during outbox persistence never replays a prompt', sum(e.get('type') == 'inference' for e in host.events()) == 3)
        g1.send('\x15')
        signalled = Terminal('signalled', 'guest-mutating', cap); ready(signalled)
        check('expected identity is captured before asynchronous startup', next(e['identity'] for e in signalled.events() if e.get('type') == 'snapshot-ready') == cap['expected'])
        os.killpg(signalled.proc.pid, signal.SIGTERM)
        wait(lambda: signalled.proc.poll() is not None, 'signal cleanup')
        check('SIGTERM restores terminal and completes cleanup', signalled.proc.returncode == 143 and signalled.terminal_restored())
        interrupted = Terminal('interrupted', 'guest', cap); ready(interrupted)
        os.killpg(interrupted.proc.pid, signal.SIGINT)
        wait(lambda: interrupted.proc.poll() is not None, 'interrupt cleanup')
        check('SIGINT exits 130 and restores terminal', interrupted.proc.returncode == 130 and interrupted.terminal_restored())
        key_interrupt = Terminal('key-interrupt', 'guest', cap); ready(key_interrupt)
        key_interrupt.send('\x03')
        wait(lambda: key_interrupt.proc.poll() is not None, 'native Ctrl-C cleanup')
        check('native Ctrl-C detaches with 130 and restores terminal', key_interrupt.proc.returncode == 130 and key_interrupt.terminal_restored())
        timed = Terminal('timed-stop', 'guest', cap); ready(timed)
        timed.command({'stopTimeout': 1})
        wait(lambda: timed.proc.poll() is not None, 'bounded stop timeout')
        check('stop timeout rejects instead of claiming clean settlement', timed.proc.returncode == 1 and timed.terminal_restored() and
              any(e.get('type') == 'failure' and 'timed out' in e.get('error', '') for e in timed.events()) and
              any(e.get('type') == 'stop-idempotent' and e['same'] for e in timed.events()))
        old = Terminal('old-version', 'raw', {**cap, 'version': 0})
        wait(lambda: any(e.get('t') == 'error' for e in old.events()), 'unsupported extension version')
        check('old negotiated version never receives a snapshot', not any(e.get('type') == 'ready' for e in old.events()))
        unauthorized = Terminal('unauthorized', 'guest', {**cap, 'capability': 'incorrect-fixture-token'})
        wait(lambda: unauthorized.proc.poll() is not None, 'invalid authentication termination')
        check('opaque authentication failure is terminal', unauthorized.proc.returncode == 1 and unauthorized.terminal_restored())
        wrong = {**cap, 'expected': {**cap['expected'], 'binding': 'wrong'}}
        bad = Terminal('wrong-binding', 'guest', wrong)
        wait(lambda: bad.proc.poll() is not None, 'wrong binding must terminate')
        check('wrong binding fails closed', bad.proc.returncode == 1 and bad.terminal_restored())
        unbound = Terminal('unbound-host', 'unbound-host'); ready(unbound)
        unbound_cap = json.loads((unbound.d/'capability.json').read_text())
        old_host_guest = Terminal('old-host-guest', 'guest', unbound_cap)
        wait(lambda: old_host_guest.proc.poll() is not None, 'bound client rejects unnegotiated host')
        check('bound startup never degrades to ordinary collaboration', old_host_guest.proc.returncode == 1 and old_host_guest.terminal_restored())
        standard = Terminal('standard-writer', 'raw', unbound_cap); ready(standard)
        standard.command({'t': 'prompt', 'text': 'UNBOUND_FIRST'})
        wait(lambda: sum(e.get('type') == 'inference' for e in unbound.events()) == 1, 'ordinary prompt')
        standard.command({'t': 'prompt', 'text': 'UNBOUND_STEER'})
        wait(lambda: sum(e.get('type') == 'inference' for e in unbound.events()) == 2, 'ordinary busy steering')
        wait(lambda: not unbound.snapshot().get('streaming', True), 'ordinary settlement')
        check('ordinary host retains native steer-on-busy behavior', any(e.get('content') == 'UNBOUND_STEER' for e in unbound.snapshot()['entries']))
        unbound.command({'stop': True})
        wait(lambda: unbound.proc.poll() is not None, 'ordinary stop')
        g2.send('\x15/leave\r')
        wait(lambda: g2.proc.poll() is not None, 'bound leave teardown')
        check('leave has no local fallback', g2.proc.returncode == 0 and g2.terminal_restored())
        g1.capture(); g2.capture()
        (host.d/'final-only').write_text('1')
        g1.send('UPDATE_FREE_COMPLETION\r')
        wait(lambda: any(e.get('type') == 'waiting-final' for e in host.events()), 'final-only boundary')
        late = Terminal('late-join', 'guest', cap); ready(late)
        settled(host, 4)
        check('completion-only boundary actually exercised', any(e.get('type') == 'suppressed-final-update' for e in host.events()))
        late.capture()
        check('update-free completion renders on late native guest', 'NATIVE-4 streaming complete.' in late.screen_text())
        g1.send('DRAIN_BEFORE_STOP\r')
        wait(lambda: sum(e.get('type') == 'inference' for e in host.events()) == 5, 'drain in flight')
        host.command({'settle': True})
        settled(host, 5)
        wait(lambda: any(e.get('type') == 'drained' for e in host.events()), 'native host settlement barrier')
        g1.send('AFTER_DRAIN\r')
        wait(lambda: any(e.get('receipt', {}).get('code') == 'stopped' for e in g1.events()), 'drain withdraws admission')
        check('settle drains without abort and flushes before returning', sum(e.get('type') == 'aborted' for e in host.events()) == 1 and sum(e.get('type') == 'inference' for e in host.events()) == 5)
        old_journal = next(e['journal'] for e in host.events() if e.get('type') == 'ready')
        host.command({'stop': True})
        wait(lambda: host.proc.poll() is not None and g1.proc.poll() is not None, 'host-stop bound cleanup')
        check('host stop leaves no usable guest', host.proc.returncode == g1.proc.returncode == 0)
        stale = Terminal('stale-room', 'guest', cap)
        wait(lambda: stale.proc.poll() is not None, 'failed join teardown')
        check('failed join has no local fallback', stale.proc.returncode == 1)
        h2 = Terminal('reopened', 'host', reopen=old_journal); ready(h2)
        cap2 = json.loads((h2.d/'capability.json').read_text())
        check('exact journal reopen and instance-local generation', cap2['expected']['sessionId'] == cap['expected']['sessionId'] and cap2['expected']['instanceId'] != cap['expected']['instanceId'] and cap2['expected']['generation'] == cap['expected']['generation'] == 1)
        g3 = Terminal('exhausted', 'guest', cap2); ready(g3)
        g3.send('REOPENED_NATIVE_INPUT\r')
        settled(h2, 1)
        check('reopened exact journal accepts a new native turn', transcript(h2) == transcript(g3) and
              next(e['journal'] for e in h2.events() if e.get('type') == 'ready') == old_journal)
        (h2.d/'settlement-fail').write_text('1')
        g3.send('SETTLEMENT_FAILURE\r')
        wait(lambda: any(e.get('receipt', {}).get('code') == 'settlement-or-policy-failed' for e in g3.events()), 'failed settlement must remain uncertain')
        check('embedder receives a correlated uncertainty callback', any(e.get('type') == 'failure-receipt' and e['receipt']['requestId'] == next(
            r['request']['requestId'] for r in g3.events() if r.get('request', {}).get('text') == 'SETTLEMENT_FAILURE') for e in h2.events()))
        uncertain = next(e['request'] for e in g3.events() if e.get('request', {}).get('text') == 'SETTLEMENT_FAILURE')
        before_retry = sum(e.get('type') == 'lookup' and e.get('requestId') == uncertain['requestId'] for e in h2.events())
        g3.command({'resubmit': uncertain})
        wait(lambda: sum(e.get('type') == 'lookup' and e.get('requestId') == uncertain['requestId'] for e in h2.events()) > before_retry, 'uncertain retry lookup')
        check('same-ID uncertain dispatch is never reexecuted', sum(e.get('type') == 'inference' for e in h2.events()) == 2)
        g3.send('AFTER_FAILED_SETTLEMENT\r')
        wait(lambda: any(e.get('receipt', {}).get('code') == 'stopped' for e in g3.events()), 'failed settlement withdraws admission')
        check('settlement failure never reports durable completion or permits more execution', sum(e.get('type') == 'inference' for e in h2.events()) == 2)
        os.killpg(relay.pid, signal.SIGTERM); relay.wait(timeout=3)
        wait(lambda: g3.proc.poll() is not None, 'exhausted reconnect teardown', 8)
        check('exhausted reconnect has no local fallback', g3.proc.returncode == 0)
        h2.command({'stop': True}); wait(lambda: h2.proc.poll() is not None, 'reopened stop')
        check('stop propagates settlement failure after terminal cleanup', h2.proc.returncode == 1 and h2.terminal_restored())
        check('no HTTP or local dispatch', not any(e.get('type') in ['blocked-fetch', 'local-dispatch'] for t in terminals for e in t.events()))
        secret_bytes = base64.urlsafe_b64decode(cap['link'].rsplit('.', 1)[1] + '==')
        secrets = [cap['link'], cap['capability'], cap['link'].rsplit('.', 1)[1]] + [
            base64.urlsafe_b64encode(b).decode().rstrip('=') for b in [secret_bytes[:32], secret_bytes[32:]] if b]
        check('capability absent from terminal output', not any(secret in t.raw for secret in secrets for t in terminals))
        logs = [p.read_text(errors='replace') for p in base.rglob('*.log')]
        check('capability absent from native logs', not any(secret in log for secret in secrets for log in logs))
    except Exception as error:
        report['failure'] = str(error)
        report['events'] = {t.name: [e for e in t.events() if e.get('type') != 'native-event'] for t in terminals}
        for terminal in terminals:
            terminal.capture()
    finally:
        signal.alarm(0)
        for child in reversed(children):
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                deadline = time.monotonic() + 12
                while child.poll() is None and time.monotonic() < deadline:
                    pump(.05)
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGKILL); child.wait(timeout=3)
        for terminal in terminals:
            terminal.drain(); os.close(terminal.master); os.close(terminal.slave_audit)
        report['cleanup'] = [{'pid': p.pid, 'exit': p.returncode} for p in children]
        report['groups'] = {str(p.pid): subprocess.run(['/bin/ps', '-o', 'pid=', '-g', str(p.pid)], capture_output=True, text=True).stdout.strip() for p in children}
        report['listener_after'] = subprocess.run(['/usr/sbin/lsof', '-nP', '-iTCP:'+url.rsplit(':', 1)[1], '-sTCP:LISTEN'], capture_output=True, text=True).stdout if url else ''
        report['daemons'] = [str(p.relative_to(base)) for p in base.rglob('daemons')]
        if any(report['groups'].values()) or report['listener_after'] or report['daemons']:
            report['failure'] = 'cleanup audit failed'
time.sleep(.3)
report['disposable_removed'] = not base.exists()
print(json.dumps(report, indent=2).replace(str(base), '[DISPOSABLE]'))
raise SystemExit(1 if report.get('failure') else 0)
