param(
    [Parameter(Mandatory = $true)]
    [int]$MainProcessId,
    [Parameter(Mandatory = $true)]
    [int]$RendererProcessId
)

$ErrorActionPreference = 'Stop'

# Read only the two processes supplied by the current Electron test. No enumeration or mutation.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class WindowsProcessPower {
    [StructLayout(LayoutKind.Sequential)]
    public struct PowerThrottlingState {
        public uint Version;
        public uint ControlMask;
        public uint StateMask;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessInformation(IntPtr process, int kind, ref PowerThrottlingState state, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetPriorityClass(IntPtr process);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public static uint[] Read(uint pid) {
        const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        const int ProcessPowerThrottling = 4;
        var process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcess failed");
        try {
            var state = new PowerThrottlingState { Version = 1 };
            if (!GetProcessInformation(process, ProcessPowerThrottling, ref state, 12)) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "GetProcessInformation failed");
            }
            var priority = GetPriorityClass(process);
            if (priority == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "GetPriorityClass failed");
            return new uint[] { priority, state.ControlMask, state.StateMask };
        } finally {
            CloseHandle(process);
        }
    }
}
'@

function Read-ProcessPower([int]$ProcessId) {
    $values = [WindowsProcessPower]::Read($ProcessId)
    [pscustomobject]@{
        pid = $ProcessId
        priority = $values[0]
        controlMask = $values[1]
        stateMask = $values[2]
        ecoQoS = ($values[1] -band $values[2] -band 1) -ne 0
    }
}

[pscustomobject]@{
    main = Read-ProcessPower $MainProcessId
    renderer = Read-ProcessPower $RendererProcessId
} | ConvertTo-Json -Compress
