// Self-extracting Windows launcher for agent-office.
//
// The final executable is laid out as:
//   [ this PE stub ][ zip payload ][ 32-byte footer ]
//   footer = "AOZIP001" | Int64LE(zip length) | 16 ASCII bytes build id
//
// On first run the zip (Node runtime + dist/ + package.json + the optional
// native pty module) is unpacked under %LOCALAPPDATA%\agent-office\<build id>\
// and node.exe dist/cli.js runs with no console window. A tray icon keeps the
// office closeable; a second double-click just reopens the browser.
//
// Nothing here needs installing: .NET Framework 4.x ships with Windows 10/11.

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

[assembly: AssemblyTitle("agent office")]
[assembly: AssemblyDescription("A live pixel-art office for your coding agents")]
[assembly: AssemblyProduct("agent office")]
[assembly: AssemblyCompany("bas3line")]
[assembly: AssemblyFileVersion("0.3.0")]
[assembly: AssemblyVersion("0.3.0.0")]

internal static class Launcher
{
    private const string Magic = "AOZIP001";
    private const int FooterSize = 32;
    private const string MutexName = @"Local\agent-office-single-instance";
    private const string Url = "http://127.0.0.1:4747/";

    private static System.Threading.Mutex _mutex;
    private static Process _node;
    private static NotifyIcon _tray;

    [STAThread]
    private static int Main(string[] args)
    {
        bool first;
        _mutex = new System.Threading.Mutex(true, MutexName, out first);
        if (!first)
        {
            // Already running: just show the office again instead of starting a second server.
            OpenBrowser(Url);
            return 0;
        }

        string root;
        try
        {
            root = Prepare();
        }
        catch (Exception e)
        {
            MessageBox.Show("agent office could not unpack itself:\n\n" + e.Message,
                "agent office", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        string node = Path.Combine(root, "runtime", "node.exe");
        string cli = Path.Combine(root, "dist", "cli.js");
        if (!File.Exists(node) || !File.Exists(cli))
        {
            MessageBox.Show("The unpacked files are incomplete. Delete\n" + root +
                "\nand run the exe again.", "agent office", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        var psi = new ProcessStartInfo(node);
        psi.WorkingDirectory = root;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        var cmd = new StringBuilder();
        cmd.Append('"').Append(cli).Append('"');
        bool openFlag = false;
        foreach (string a in args)
        {
            cmd.Append(' ').Append(Quote(a));
            if (a == "--open" || a == "--no-open") openFlag = true;
        }
        // Real agents by default; --demo (passed through above) switches to the simulated office.
        if (!openFlag) cmd.Append(" --open");
        psi.Arguments = cmd.ToString();
        try { psi.EnvironmentVariables.Remove("CI"); } catch { }
        // CI in the environment would suppress the browser; BROWSER=none is left to the user.

        try
        {
            _node = Process.Start(psi);
        }
        catch (Exception e)
        {
            MessageBox.Show("Could not start the bundled Node runtime:\n\n" + e.Message,
                "agent office", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        Application.EnableVisualStyles();
        _tray = new NotifyIcon();
        _tray.Icon = SystemIcons.Application;
        _tray.Text = "agent office - " + Url;
        _tray.Visible = true;
        _tray.ContextMenu = new ContextMenu(new MenuItem[]
        {
            new MenuItem("Open office", delegate { OpenBrowser(Url); }),
            new MenuItem("Quit", delegate { Quit(); })
        });
        _tray.DoubleClick += delegate { OpenBrowser(Url); };
        _tray.ShowBalloonTip(5000, "agent office",
            "Starting at " + Url + "\nRight-click the tray icon to quit.", ToolTipIcon.Info);

        var timer = new System.Windows.Forms.Timer();
        timer.Interval = 1500;
        timer.Tick += delegate
        {
            bool gone;
            try { gone = _node == null || _node.HasExited; }
            catch { gone = true; }
            if (gone) { timer.Stop(); Quit(); }
        };
        timer.Start();

        Application.Run();
        return 0;
    }

    /** Unpack once per build id; returns the directory holding runtime/ and dist/. */
    private static string Prepare()
    {
        string exe = Assembly.GetExecutingAssembly().Location;
        byte[] footer = new byte[FooterSize];
        using (var fs = new FileStream(exe, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            if (fs.Length < FooterSize + 64) throw new InvalidDataException("no payload found");
            fs.Seek(-FooterSize, SeekOrigin.End);
            ReadFully(fs, footer);
            if (Encoding.ASCII.GetString(footer, 0, 8) != Magic)
                throw new InvalidDataException("payload footer not found");
            long zipLen = BitConverter.ToInt64(footer, 8);
            if (zipLen <= 0 || zipLen > fs.Length - FooterSize)
                throw new InvalidDataException("bad payload size");
            string buildId = Encoding.ASCII.GetString(footer, 16, 16).Trim();
            if (buildId.Length == 0) buildId = "default";
            foreach (char c in buildId)
                if (!char.IsLetterOrDigit(c) && c != '-' && c != '_' && c != '.')
                    throw new InvalidDataException("bad build id");

            string baseDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "agent-office");
            string target = Path.Combine(baseDir, buildId);
            string ready = Path.Combine(target, ".ready");
            if (File.Exists(ready)) return target;

            if (Directory.Exists(target)) Directory.Delete(target, true);
            Directory.CreateDirectory(target);

            long zipStart = fs.Length - FooterSize - zipLen;
            fs.Position = zipStart;
            byte[] data = new byte[checked((int)zipLen)];
            ReadFully(fs, data);
            using (var ms = new MemoryStream(data, false))
            using (var zip = new ZipArchive(ms, ZipArchiveMode.Read))
            {
                foreach (var entry in zip.Entries)
                {
                    string name = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                    string dest = Path.GetFullPath(Path.Combine(target, name));
                    if (dest != target &&
                        !dest.StartsWith(target + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("unsafe entry: " + entry.FullName);
                    if (entry.FullName.EndsWith("/") || entry.Name.Length == 0)
                    {
                        Directory.CreateDirectory(dest);
                        continue;
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(dest));
                    using (var src = entry.Open())
                    using (var dst = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.None))
                        src.CopyTo(dst);
                }
            }
            File.WriteAllText(ready, buildId);

            // Drop payloads from earlier builds when nothing is using them.
            try
            {
                foreach (string d in Directory.GetDirectories(baseDir))
                {
                    if (string.Equals(Path.GetFileName(d), buildId, StringComparison.OrdinalIgnoreCase)) continue;
                    if (File.Exists(Path.Combine(d, ".ready"))) Directory.Delete(d, true);
                }
            }
            catch { }
            return target;
        }
    }

    private static void ReadFully(Stream s, byte[] b)
    {
        int off = 0;
        while (off < b.Length)
        {
            int n = s.Read(b, off, b.Length - off);
            if (n <= 0) throw new EndOfStreamException();
            off += n;
        }
    }

    private static string Quote(string a)
    {
        if (a.Length > 0 && a.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return a;
        return "\"" + a.Replace("\"", "\\\"") + "\"";
    }

    private static void OpenBrowser(string url)
    {
        try
        {
            var psi = new ProcessStartInfo(url) { UseShellExecute = true };
            Process.Start(psi);
        }
        catch { }
    }

    private static void Quit()
    {
        try
        {
            if (_node != null && !_node.HasExited)
            {
                var psi = new ProcessStartInfo("taskkill.exe", "/PID " + _node.Id + " /T /F");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                Process p = Process.Start(psi);
                if (p != null) p.WaitForExit(3000);
            }
        }
        catch
        {
            try { if (_node != null && !_node.HasExited) _node.Kill(); } catch { }
        }
        if (_tray != null) { _tray.Visible = false; _tray.Dispose(); }
        Application.Exit();
    }
}
