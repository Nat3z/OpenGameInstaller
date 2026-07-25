param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string] $Command,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $CommandArguments
)

$nativeSource = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class OgiJobRunner
{
    private const uint CreateSuspended = 0x00000004;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint Infinite = 0xffffffff;
    private const uint WaitObject0 = 0x00000000;
    private const uint WaitFailed = 0xffffffff;
    private const uint JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint DuplicateSameAccess = 0x00000002;
    private const uint ProcThreadAttributeHandleList = 0x00020002;
    private const int StdInputHandle = -10;
    private const int StdOutputHandle = -11;
    private const int StdErrorHandle = -12;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
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
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx
    {
        public StartupInfo StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
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
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformationValue
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(
        IntPtr jobAttributes,
        string name
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        uint informationClass,
        ref JobObjectExtendedLimitInformationValue information,
        uint informationLength
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfoEx startupInfo,
        out ProcessInformation processInformation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(
        IntPtr job,
        IntPtr process
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint timeout);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint code);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(
        IntPtr sourceProcess,
        IntPtr sourceHandle,
        IntPtr targetProcess,
        out IntPtr targetHandle,
        uint desiredAccess,
        bool inheritHandle,
        uint options
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributeList,
        int attributeCount,
        int flags,
        ref IntPtr size
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributeList,
        uint flags,
        IntPtr attribute,
        IntPtr value,
        IntPtr size,
        IntPtr previousValue,
        IntPtr returnSize
    );

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(
        IntPtr attributeList
    );

    private static void ThrowLastError(string operation)
    {
        ThrowError(operation, Marshal.GetLastWin32Error());
    }

    private static void ThrowError(string operation, int error)
    {
        throw new Win32Exception(error, operation + " failed");
    }

    private static IntPtr DuplicateStandardHandle(int standardHandle)
    {
        IntPtr source = GetStdHandle(standardHandle);
        if (source == IntPtr.Zero || source == new IntPtr(-1))
            throw new InvalidOperationException(
                "Required standard handle is unavailable: " + standardHandle
            );
        IntPtr duplicate;
        IntPtr currentProcess = GetCurrentProcess();
        if (!DuplicateHandle(
            currentProcess,
            source,
            currentProcess,
            out duplicate,
            0,
            true,
            DuplicateSameAccess
        )) ThrowLastError("DuplicateHandle");
        return duplicate;
    }

    public static int Run(string commandLine)
    {
        IntPtr job = IntPtr.Zero;
        IntPtr stdin = IntPtr.Zero;
        IntPtr stdout = IntPtr.Zero;
        IntPtr stderr = IntPtr.Zero;
        IntPtr attributeList = IntPtr.Zero;
        IntPtr handleList = IntPtr.Zero;
        bool attributeListInitialized = false;
        ProcessInformation process = new ProcessInformation();
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) ThrowLastError("CreateJobObject");

            var limits = new JobObjectExtendedLimitInformationValue();
            limits.BasicLimitInformation.LimitFlags =
                JobObjectLimitKillOnJobClose;
            if (!SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                ref limits,
                (uint)Marshal.SizeOf(limits)
            )) ThrowLastError("SetInformationJobObject");

            var startup = new StartupInfoEx();
            startup.StartupInfo.cb = (uint)Marshal.SizeOf(startup);
            stdin = DuplicateStandardHandle(StdInputHandle);
            stdout = DuplicateStandardHandle(StdOutputHandle);
            stderr = DuplicateStandardHandle(StdErrorHandle);
            startup.StartupInfo.dwFlags = StartfUseStdHandles;
            startup.StartupInfo.hStdInput = stdin;
            startup.StartupInfo.hStdOutput = stdout;
            startup.StartupInfo.hStdError = stderr;

            IntPtr attributeListSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(
                IntPtr.Zero,
                1,
                0,
                ref attributeListSize
            );
            attributeList = Marshal.AllocHGlobal(attributeListSize);
            if (!InitializeProcThreadAttributeList(
                attributeList,
                1,
                0,
                ref attributeListSize
            )) ThrowLastError("InitializeProcThreadAttributeList");
            attributeListInitialized = true;
            startup.lpAttributeList = attributeList;

            IntPtr[] inheritedHandles = { stdin, stdout, stderr };
            handleList = Marshal.AllocHGlobal(IntPtr.Size * inheritedHandles.Length);
            Marshal.Copy(inheritedHandles, 0, handleList, inheritedHandles.Length);
            if (!UpdateProcThreadAttribute(
                attributeList,
                0,
                new IntPtr((long)ProcThreadAttributeHandleList),
                handleList,
                new IntPtr(IntPtr.Size * inheritedHandles.Length),
                IntPtr.Zero,
                IntPtr.Zero
            )) ThrowLastError("UpdateProcThreadAttribute");

            if (!CreateProcess(
                null,
                new StringBuilder(commandLine),
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CreateSuspended | ExtendedStartupInfoPresent,
                IntPtr.Zero,
                null,
                ref startup,
                out process
            )) ThrowLastError("CreateProcess");

            if (!AssignProcessToJobObject(job, process.hProcess))
            {
                int error = Marshal.GetLastWin32Error();
                TerminateProcess(process.hProcess, 1);
                ThrowError("AssignProcessToJobObject", error);
            }
            if (ResumeThread(process.hThread) == 0xffffffff)
            {
                int error = Marshal.GetLastWin32Error();
                TerminateProcess(process.hProcess, 1);
                ThrowError("ResumeThread", error);
            }

            uint waitResult = WaitForSingleObject(process.hProcess, Infinite);
            if (waitResult == WaitFailed)
                ThrowLastError("WaitForSingleObject");
            if (waitResult != WaitObject0)
                throw new InvalidOperationException(
                    "Unexpected process wait result: " + waitResult
                );
            uint exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode))
                ThrowLastError("GetExitCodeProcess");
            return unchecked((int)exitCode);
        }
        finally
        {
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (stdin != IntPtr.Zero) CloseHandle(stdin);
            if (stdout != IntPtr.Zero) CloseHandle(stdout);
            if (stderr != IntPtr.Zero) CloseHandle(stderr);
            if (attributeListInitialized)
            {
                DeleteProcThreadAttributeList(attributeList);
            }
            if (attributeList != IntPtr.Zero) Marshal.FreeHGlobal(attributeList);
            if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
            // KILL_ON_JOB_CLOSE removes every surviving descendant.
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }
}
'@

function ConvertTo-WindowsCommandLineArgument([string] $Value) {
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
    return $Value
  }
  $quoted = '"'
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') {
      $backslashes += 1
      continue
    }
    if ($character -eq '"') {
      $quoted += ('\' * (($backslashes * 2) + 1)) + '"'
      $backslashes = 0
      continue
    }
    $quoted += ('\' * $backslashes) + $character
    $backslashes = 0
  }
  return $quoted + ('\' * ($backslashes * 2)) + '"'
}

Add-Type -TypeDefinition $nativeSource -Language CSharp
$commandLine = (@($Command) + $CommandArguments |
    ForEach-Object { ConvertTo-WindowsCommandLineArgument $_ }) -join ' '

try {
  exit [OgiJobRunner]::Run($commandLine)
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
}
