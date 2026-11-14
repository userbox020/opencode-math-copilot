# Evaluator-side only. ASCII source for Windows PowerShell 5.1; wire JSON is UTF-8.
# Child output never passes through PowerShell's text pipeline.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$source = @'
using System;
using System.Text;
using System.IO;
using System.Threading;
using System.Diagnostics;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

public sealed class OwnedReceipt {
    public string nonce;
    public int helper_pid = Process.GetCurrentProcess().Id;
    public int? pid;
    public long? exit_code;
    public bool job_assigned;
    public bool kill_on_close;
    public bool enclosing_job_present;
    public bool cleanup_confirmed;
    public uint? active_before;
    public uint? active_after;
    public string reason;
    public string spawn_error;
    public int? win32_error;
}
public static class OwnedWindowsJob {
    [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int length; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO {
        public int cb; public IntPtr reserved, desktop, title;
        public int x, y, xSize, ySize, xChars, yChars, fill, flags;
        public short show, reserved2; public IntPtr reservedPtr, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
        public long processTime, jobTime; public uint flags;
        public UIntPtr minWorking, maxWorking; public uint activeLimit;
        public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong rOps, wOps, oOps, rBytes, wBytes, oBytes; }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory, jobMemory, peakProcess, peakJob; }
    [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long user, kernel, periodUser, periodKernel; public uint faults, total, active, terminated; }
    [StructLayout(LayoutKind.Sequential)] struct FILE_INFORMATION {
        public uint attributes, creationLow, creationHigh, accessLow, accessHigh, writeLow, writeHigh;
        public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
    }
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref EXTENDED_LIMIT info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int type, out ACCOUNTING info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool inJob);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint millis);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateFileW(string name, uint access, uint share, ref SECURITY_ATTRIBUTES security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr file, out FILE_INFORMATION info);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetFileType(IntPtr file);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern uint GetFinalPathNameByHandleW(IntPtr file, StringBuilder path, uint size, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr file, byte[] bytes, uint count, out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFilePointerEx(IntPtr file, long offset, out long position, uint method);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string app, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref STARTUPINFOEX startup, out PROCESS_INFORMATION info);

    static void Check(bool ok, string operation) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation); }
    static bool Valid(IntPtr h) { return h != IntPtr.Zero && h != new IntPtr(-1); }
    static string Quote(string arg) {
        StringBuilder result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in arg) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); }
            else { result.Append('\\', slashes); result.Append(c); }
            slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
    }
    static uint Active(IntPtr job) {
        ACCOUNTING info;
        Check(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(ACCOUNTING)), IntPtr.Zero), "QueryInformationJobObject");
        return info.active;
    }
    static IntPtr CopyStd(int which) {
        IntPtr handle;
        Check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(which), GetCurrentProcess(), out handle, 0, true, 2), "DuplicateHandle");
        return handle;
    }
    static IntPtr OpenInput(string file, string expectedHash, ref SECURITY_ATTRIBUTES security) {
        IntPtr input = IntPtr.Zero;
        try {
            string expectedPath = Path.Combine(Environment.CurrentDirectory, "stdin.bin");
            if (file == null || !Regex.IsMatch(file, @"\A[A-Za-z]:\\[^\x00-\x1f:*?""<>|]+\z") ||
                !String.Equals(file, Path.GetFullPath(file), StringComparison.OrdinalIgnoreCase) ||
                !String.Equals(file, expectedPath, StringComparison.OrdinalIgnoreCase) ||
                expectedHash == null || !Regex.IsMatch(expectedHash, @"\A[a-f0-9]{64}\z")) throw new IOException();
            for (DirectoryInfo dir = new DirectoryInfo(Path.GetDirectoryName(file)); dir != null; dir = dir.Parent)
                if ((dir.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException();
            // READ only, SHARE_READ only: no writer or delete/replace while this
            // exact inherited handle is verified and consumed by the child.
            input = CreateFileW(file, 0x80000000, 1, ref security, 3, 0x00200000, IntPtr.Zero);
            Check(Valid(input), "stdin");
            FILE_INFORMATION info;
            Check(GetFileInformationByHandle(input, out info), "stdin");
            if (GetFileType(input) != 1 || (info.attributes & 0x410) != 0 || info.links != 1 ||
                info.sizeHigh != 0 || info.sizeLow > 1048576) throw new IOException();
            StringBuilder resolved = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandleW(input, resolved, (uint)resolved.Capacity, 0);
            if (length == 0 || length >= resolved.Capacity ||
                !String.Equals(resolved.ToString(), @"\\?\" + file, StringComparison.OrdinalIgnoreCase)) throw new IOException();
            byte[] bytes = new byte[info.sizeLow];
            uint read;
            Check(ReadFile(input, bytes, (uint)bytes.Length, out read, IntPtr.Zero), "stdin");
            if (read != bytes.Length) throw new IOException();
            byte[] extra = new byte[1];
            Check(ReadFile(input, extra, 1, out read, IntPtr.Zero), "stdin");
            if (read != 0) throw new IOException();
            using (SHA256 sha = SHA256.Create()) {
                string actualHash = BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
                if (actualHash != expectedHash) throw new IOException();
            }
            Array.Clear(bytes, 0, bytes.Length);
            long position;
            Check(SetFilePointerEx(input, 0, out position, 0), "stdin");
            if (position != 0) throw new IOException();
            return input;
        } catch {
            if (Valid(input)) CloseHandle(input);
            throw new InvalidDataException("stdin_rejected");
        }
    }
    public static OwnedReceipt Run(string executable, string[] args, string cwd, string[] environment, int timeout, int cleanupMs, string nonce,
        bool stdinProvided, string stdinPath, string stdinHash) {
        OwnedReceipt result = new OwnedReceipt(); result.nonce = nonce;
        IntPtr job = IntPtr.Zero, env = IntPtr.Zero, handles = IntPtr.Zero, jobList = IntPtr.Zero, input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
        STARTUPINFOEX startup = new STARTUPINFOEX(); PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        bool attributesInitialized = false;
        ManualResetEvent cancelled = new ManualResetEvent(false);
        // EOF also covers abrupt evaluator death. This background thread never owns
        // the job handle; normal helper return/OS termination closes that handle.
        Thread monitor = new Thread(delegate() { try { Console.In.ReadLine(); } catch {} cancelled.Set(); });
        monitor.IsBackground = true; monitor.Start();
        try {
            bool enclosingJob;
            Check(IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out enclosingJob), "IsProcessInJob");
            result.enclosing_job_present = enclosingJob;
            job = CreateJobObjectW(IntPtr.Zero, null); Check(Valid(job), "CreateJobObjectW");
            EXTENDED_LIMIT limits = new EXTENDED_LIMIT();
            limits.basic.flags = 0x2000; // KILL_ON_JOB_CLOSE only; no BREAKAWAY or SILENT_BREAKAWAY.
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))), "SetInformationJobObject");
            result.kill_on_close = true;
            if (cancelled.WaitOne(0)) { result.reason = "cancel"; return result; }
            SECURITY_ATTRIBUTES security = new SECURITY_ATTRIBUTES(); security.length = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)); security.inherit = 1;
            if (stdinProvided) input = OpenInput(stdinPath, stdinHash, ref security);
            else { input = CreateFileW("NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero); Check(Valid(input), "CreateFileW(stdin)"); }
            output = CopyStd(-11); error = CopyStd(-12);
            startup.startup.cb = Marshal.SizeOf(typeof(STARTUPINFOEX)); startup.startup.flags = 0x100;
            startup.startup.input = input; startup.startup.output = output; startup.startup.error = error;
            IntPtr bytes = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref bytes);
            startup.attributes = Marshal.AllocHGlobal(bytes);
            Check(InitializeProcThreadAttributeList(startup.attributes, 2, 0, ref bytes), "InitializeProcThreadAttributeList"); attributesInitialized = true;
            handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handles, 0, input); Marshal.WriteIntPtr(handles, IntPtr.Size, output); Marshal.WriteIntPtr(handles, 2 * IntPtr.Size, error);
            Check(UpdateProcThreadAttribute(startup.attributes, 0, new IntPtr(0x20002), handles, new IntPtr(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "UpdateProcThreadAttribute(handle-list)");
            // Windows 10+ JOB_LIST assigns atomically inside CreateProcess, closing
            // the create-suspended/AssignProcessToJobObject helper-death race. A
            // restrictive outer job or unsupported OS fails closed, never retries.
            jobList = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList, job);
            Check(UpdateProcThreadAttribute(startup.attributes, 0, new IntPtr(0x2000d), jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "UpdateProcThreadAttribute(job-list)");
            Array.Sort(environment, StringComparer.OrdinalIgnoreCase);
            env = Marshal.StringToHGlobalUni(String.Join("\0", environment) + "\0\0");
            StringBuilder command = new StringBuilder(Quote(executable));
            foreach (string arg in args) { command.Append(' '); command.Append(Quote(arg)); }
            // SUSPENDED | UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW
            Check(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080404, env, cwd, ref startup, out process), "CreateProcessW");
            result.pid = (int)process.pid;
            bool assigned;
            Check(IsProcessInJob(process.process, job, out assigned), "IsProcessInJob(owned)");
            if (!assigned) throw new InvalidOperationException("atomic_job_assignment_missing");
            result.job_assigned = true;
            Check(ResumeThread(process.thread) != 0xffffffff, "ResumeThread");
            Stopwatch clock = Stopwatch.StartNew();
            while (true) {
                uint wait = WaitForSingleObject(process.process, 20);
                if (wait == 0) { uint code; Check(GetExitCodeProcess(process.process, out code), "GetExitCodeProcess"); result.exit_code = code; result.reason = "exit"; break; }
                if (wait != 258) { Check(false, "WaitForSingleObject"); }
                if (cancelled.WaitOne(0)) { result.reason = "cancel"; break; }
                if (clock.ElapsedMilliseconds >= timeout) { result.reason = "timeout"; break; }
            }
        } catch (InvalidDataException) {
            result.reason = "stdin_rejected"; result.spawn_error = "stdin_rejected";
        } catch (Win32Exception exception) {
            result.reason = "start-or-wait-error"; result.spawn_error = exception.Message; result.win32_error = exception.NativeErrorCode;
        } catch {
            result.reason = "helper-error"; result.spawn_error = "managed_helper_error";
        } finally {
            try {
                bool unassignedReaped = true;
                if (Valid(process.process) && !result.job_assigned) {
                    Check(TerminateProcess(process.process, 1), "TerminateProcess(suspended)");
                    unassignedReaped = WaitForSingleObject(process.process, (uint)cleanupMs) == 0;
                }
                if (Valid(job)) {
                    result.active_before = Active(job);
                    Check(TerminateJobObject(job, 1), "TerminateJobObject");
                    Stopwatch deadline = Stopwatch.StartNew();
                    do {
                        result.active_after = Active(job);
                        if (result.active_after == 0) break;
                        Thread.Sleep(10);
                    } while (deadline.ElapsedMilliseconds < cleanupMs);
                    result.cleanup_confirmed = result.active_after == 0 && unassignedReaped;
                } else { result.cleanup_confirmed = !Valid(process.process); result.active_after = 0; }
            } catch (Win32Exception exception) { result.win32_error = exception.NativeErrorCode; result.cleanup_confirmed = false; }
              catch { result.cleanup_confirmed = false; }
            if (Valid(job)) CloseHandle(job);
            if (Valid(process.thread)) CloseHandle(process.thread);
            if (Valid(process.process)) CloseHandle(process.process);
            if (attributesInitialized) DeleteProcThreadAttributeList(startup.attributes);
            if (startup.attributes != IntPtr.Zero) Marshal.FreeHGlobal(startup.attributes);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
            if (env != IntPtr.Zero) Marshal.FreeHGlobal(env);
            if (Valid(input)) CloseHandle(input);
            if (Valid(output)) CloseHandle(output);
            if (Valid(error)) CloseHandle(error);
        }
        return result;
    }
}
'@
try {
    Add-Type -TypeDefinition $source -Language CSharp
    $line = [Console]::ReadLine()
    if ($null -eq $line -or $line.Length -gt 262144) { exit 2 }
    $request = $line | ConvertFrom-Json
    [string[]] $environment = @($request.env.PSObject.Properties | ForEach-Object { $_.Name + '=' + [string]$_.Value })
    $stdinProvided = ($request.PSObject.Properties.Name -contains 'stdin_path') -or ($request.PSObject.Properties.Name -contains 'stdin_sha256')
    $receipt = [OwnedWindowsJob]::Run([string]$request.executable, [string[]]$request.args, [string]$request.cwd,
        $environment, [int]$request.timeoutMs, [int]$request.cleanupMs, [string]$request.nonce,
        $stdinProvided, [string]$request.stdin_path, [string]$request.stdin_sha256)
    $json = $receipt | ConvertTo-Json -Depth 4 -Compress
    # Separate fresh evidence, never mixed with target stdout/stderr. No request/env
    # values or command line are exported. FileMode.CreateNew refuses overwrite.
    $file = New-Object System.IO.FileStream([string]$request.receiptPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
        $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($json)
        $file.Write($bytes, 0, $bytes.Length)
        $file.Flush($true)
    } finally { $file.Dispose() }
    exit 0
} catch {
    # No arbitrary exception text (which could echo config) or PowerShell progress.
    [Console]::Error.WriteLine('OWNED_JOB_HELPER_FAILURE')
    exit 2
}
