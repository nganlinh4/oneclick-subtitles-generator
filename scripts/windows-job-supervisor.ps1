#requires -Version 7.2

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateRange(1, [int]::MaxValue)]
    [int]$OwnerProcessId,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$ManagedPathSentinel1,

    [string]$ManagedPathSentinel2,
    [string]$ManagedPathSentinel3,
    [string]$ManagedPathSentinel4,
    [string]$ManagedPathSentinel5,
    [string]$ManagedPathSentinel6,
    [string]$ManagedPathSentinel7,
    [string]$ManagedPathSentinel8,

    [Parameter(Mandatory)]
    [string]$InvocationBase64
)

$ErrorActionPreference = 'Stop'

$managedPathSentinels = @(
    $ManagedPathSentinel1,
    $ManagedPathSentinel2,
    $ManagedPathSentinel3,
    $ManagedPathSentinel4,
    $ManagedPathSentinel5,
    $ManagedPathSentinel6,
    $ManagedPathSentinel7,
    $ManagedPathSentinel8
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
foreach ($sentinel in $managedPathSentinels) {
    $normalized = $sentinel.Replace('/', '\')
    if (-not [IO.Path]::IsPathFullyQualified($sentinel) -or
        $normalized.StartsWith('\\?\') -or
        $normalized.StartsWith('\\.\') -or
        $normalized.StartsWith('\??\') -or
        $normalized.StartsWith('\\??\') -or
        ($normalized -split '\\' | Where-Object { $_ -eq '.' -or $_ -eq '..' }).Count -gt 0) {
        throw "Managed path sentinel must be one unambiguous absolute path: $sentinel"
    }
}

if ($null -eq ('OsgWindowsJobSupervisor' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class OsgWindowsJobSupervisor
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const uint WAIT_FAILED = 0xffffffff;
    private const uint INFINITE = 0xffffffff;
    private const int JobObjectExtendedLimitInformation = 9;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForMultipleObjects(
        uint count,
        IntPtr[] handles,
        bool waitAll,
        uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private static void ThrowLastError(string operation)
    {
        throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }

    private static string QuoteArgument(string value)
    {
        if (value == null) throw new ArgumentNullException("argument");
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
            return value;

        var result = new StringBuilder();
        result.Append('"');
        var slashes = 0;
        foreach (var character in value)
        {
            if (character == '\\')
            {
                slashes += 1;
                continue;
            }
            if (character == '"')
            {
                result.Append('\\', slashes * 2 + 1);
                result.Append('"');
                slashes = 0;
                continue;
            }
            result.Append('\\', slashes);
            slashes = 0;
            result.Append(character);
        }
        result.Append('\\', slashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static string BuildCommandLine(string executable, string[] arguments)
    {
        var values = new List<string> { QuoteArgument(executable) };
        foreach (var argument in arguments ?? Array.Empty<string>())
            values.Add(QuoteArgument(argument));
        return string.Join(" ", values);
    }

    public static int Run(
        int ownerProcessId,
        string executable,
        string workingDirectory,
        string[] arguments,
        string verbatimCommandLine)
    {
        if (string.IsNullOrWhiteSpace(executable))
            throw new ArgumentException("The supervised executable is required.", "executable");
        if (string.IsNullOrWhiteSpace(workingDirectory))
            throw new ArgumentException("The supervised working directory is required.", "workingDirectory");

        IntPtr owner = IntPtr.Zero;
        IntPtr job = IntPtr.Zero;
        IntPtr process = IntPtr.Zero;
        IntPtr thread = IntPtr.Zero;
        IntPtr limitsMemory = IntPtr.Zero;
        var resumed = false;
        try
        {
            owner = OpenProcess(SYNCHRONIZE, false, ownerProcessId);
            if (owner == IntPtr.Zero) ThrowLastError("Could not bind the supervisor to its lease owner");

            job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero) ThrowLastError("Could not create the managed child Job Object");
            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            var limitsSize = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            limitsMemory = Marshal.AllocHGlobal(limitsSize);
            Marshal.StructureToPtr(limits, limitsMemory, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, limitsMemory, (uint)limitsSize))
                ThrowLastError("Could not apply kill-on-close to the managed child Job Object");

            var startup = new STARTUPINFO();
            startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
            startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
            startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
            PROCESS_INFORMATION created;
            var childCommandLine = string.IsNullOrEmpty(verbatimCommandLine)
                ? BuildCommandLine(executable, arguments)
                : verbatimCommandLine;
            var commandLine = new StringBuilder(childCommandLine);
            if (!CreateProcessW(
                executable,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CREATE_SUSPENDED,
                IntPtr.Zero,
                workingDirectory,
                ref startup,
                out created))
                ThrowLastError("Could not create the managed child in a suspended state");
            process = created.hProcess;
            thread = created.hThread;

            if (!AssignProcessToJobObject(job, process))
                ThrowLastError("Could not assign the suspended child to its Job Object");
            if (ResumeThread(thread) == 0xffffffff)
                ThrowLastError("Could not resume the managed child after Job Object assignment");
            resumed = true;
            CloseHandle(thread);
            thread = IntPtr.Zero;

            var wait = WaitForMultipleObjects(2, new[] { process, owner }, false, INFINITE);
            if (wait == WAIT_FAILED) ThrowLastError("Could not wait for the managed child and lease owner");
            if (wait == WAIT_OBJECT_0 + 1)
            {
                // Closing the last Job Object handle below is the authoritative tree kill. This
                // direct termination only shortens the interval before the finally block executes.
                TerminateProcess(process, 1);
                return 1;
            }
            if (wait != WAIT_OBJECT_0)
                throw new InvalidOperationException("The managed process wait returned an unknown state.");
            uint exitCode;
            if (!GetExitCodeProcess(process, out exitCode))
                ThrowLastError("Could not read the managed child exit code");
            return unchecked((int)exitCode);
        }
        finally
        {
            if (!resumed && process != IntPtr.Zero) TerminateProcess(process, 1);
            if (thread != IntPtr.Zero) CloseHandle(thread);
            if (process != IntPtr.Zero) CloseHandle(process);
            if (limitsMemory != IntPtr.Zero) Marshal.FreeHGlobal(limitsMemory);
            // Closing this handle kills every still-running process in the tree.
            if (job != IntPtr.Zero) CloseHandle(job);
            if (owner != IntPtr.Zero) CloseHandle(owner);
        }
    }
}
'@
}

try {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($InvocationBase64))
    $invocation = $json | ConvertFrom-Json
    if ($null -eq $invocation -or
        [string]::IsNullOrWhiteSpace([string]$invocation.executable) -or
        [string]::IsNullOrWhiteSpace([string]$invocation.cwd) -or
        $null -eq $invocation.arguments) {
        throw 'The supervised invocation contract is incomplete.'
    }
    $exitCode = [OsgWindowsJobSupervisor]::Run(
        $OwnerProcessId,
        [string]$invocation.executable,
        [string]$invocation.cwd,
        [string[]]$invocation.arguments,
        [string]$invocation.verbatimCommandLine
    )
    exit $exitCode
}
catch {
    [Console]::Error.WriteLine("Windows Job Object supervisor failed: $($_.Exception.Message)")
    exit 1
}
