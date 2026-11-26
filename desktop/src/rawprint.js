// Sends bytes to a Windows printer as they are (a RAW print job), past the
// printer's driver. Uses Windows' own spooler through PowerShell, so the app
// needs no native modules.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const TIMEOUT_MS = 30000;

const SCRIPT = `
$ErrorActionPreference = 'Stop'
$printer = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PRINTER__'))
$file = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__FILE__'))
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class UryRawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool ClosePrinter(IntPtr handle);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern int StartDocPrinter(IntPtr handle, int level, [In] DOCINFO info);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool EndDocPrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool StartPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool EndPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool WritePrinter(IntPtr handle, byte[] bytes, int count, out int written);
  public static void Send(string printer, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("Printer not found (error " + Marshal.GetLastWin32Error() + ")");
    try {
      DOCINFO info = new DOCINFO { pDocName = "URY ticket", pDataType = "RAW" };
      if (StartDocPrinter(h, 1, info) == 0) throw new Exception("The printer refused the job (error " + Marshal.GetLastWin32Error() + ")");
      try {
        StartPagePrinter(h);
        int written;
        if (!WritePrinter(h, bytes, bytes.Length, out written) || written != bytes.Length) throw new Exception("Could not send the ticket (error " + Marshal.GetLastWin32Error() + ")");
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
'@
try {
  [UryRawPrint]::Send($printer, [IO.File]::ReadAllBytes($file))
} catch {
  $e = $_.Exception
  if ($e.InnerException) { $e = $e.InnerException }
  [Console]::Error.WriteLine($e.Message)
  exit 1
}
`;

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

/** Sends bytes to the named Windows printer as a RAW job. */
function printRaw(bytes, deviceName, { execFileImpl = execFile } = {}) {
  const base = path.join(os.tmpdir(), `ury-raw-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const file = `${base}.bin`;
  const scriptFile = `${base}.ps1`;
  fs.writeFileSync(file, bytes);
  // Names travel base64-encoded, so no printer name can break out of the script.
  // Run from a file: PowerShell hangs on a script this long given as -EncodedCommand.
  fs.writeFileSync(scriptFile, SCRIPT.replace('__PRINTER__', b64(deviceName)).replace('__FILE__', b64(file)), 'utf8');
  return new Promise((resolve, reject) => {
    const child = execFileImpl(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile],
      { timeout: TIMEOUT_MS, windowsHide: true },
      (error, _stdout, stderr) => {
        fs.rm(file, { force: true }, () => undefined);
        fs.rm(scriptFile, { force: true }, () => undefined);
        if (!error) return resolve();
        const message = String(stderr || '').replace(/#< CLIXML[\s\S]*/, '').trim() || error.message;
        reject(new Error(message.split('\n')[0]));
      }
    );
    // PowerShell waits for input until its stdin is closed.
    if (child && child.stdin) child.stdin.end();
  });
}

module.exports = { printRaw };
