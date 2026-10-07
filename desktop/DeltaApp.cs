// Delta.exe: Delta's desktop app.
//
// Opens Delta in her own window (Microsoft Edge in app mode: no tabs or address bar), showing the
// same chat page as the website, served by her gatekeeper on this PC. If her servers aren't running
// yet, it starts them (voice, brush, gatekeeper; no tunnel) and, when you close her window, puts her
// to sleep properly and stops the servers it started. If she's already running (e.g. online through
// start-delta.ps1), it just opens her window and leaves everything else alone.
//
// Build: desktop/build.ps1 (uses the C# compiler that comes with Windows). Delta.exe goes in the
// repo folder, next to ai.html; it finds everything relative to itself.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

static class DeltaApp
{
    const string Gatekeeper = "http://127.0.0.1:8787";
    const string Voice = "http://127.0.0.1:8788";
    const string Brush = "http://127.0.0.1:8789";

    static string root;
    static readonly List<Process> started = new List<Process>();
    static Label status;

    [STAThread]
    static void Main()
    {
        root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        if (!File.Exists(Path.Combine(root, @"server\gatekeeper.js")))
        {
            MessageBox.Show("Delta.exe needs to sit in the DeltaProject folder (next to ai.html).", "Delta");
            return;
        }

        bool firstCopy;
        using (var mutex = new Mutex(true, "DeltaDesktopApp", out firstCopy))
        {
            if (!firstCopy)
            {
                MessageBox.Show("Delta's window is already open.", "Delta");
                return;
            }
            Run();
        }
    }

    static void Run()
    {
        Application.EnableVisualStyles();
        Form splash = Splash();
        splash.Show();
        Say("Waking Delta up...");

        bool ownServers = !Alive(Gatekeeper + "/health");
        if (ownServers)
        {
            if (!Alive(Voice + "/health")) Start("voice", Path.Combine(root, @"server\.venv\Scripts\python.exe"), Quote(Path.Combine(root, @"server\tts_server.py")));
            string artPython = Path.Combine(root, @"server\.venv-art\Scripts\python.exe");
            if (File.Exists(artPython) && !Alive(Brush + "/health")) Start("brush", artPython, Quote(Path.Combine(root, @"server\art_server.py")));
            Start("gatekeeper", FindNode(), Quote(Path.Combine(root, @"server\gatekeeper.js")));
        }

        if (!WaitFor(Gatekeeper + "/health", 60, "Waking Delta up..."))
        {
            splash.Close();
            MessageBox.Show("Delta's server didn't start. Is Ollama running?\n\nLogs: " + Path.GetTempPath() + "delta-app-*.log", "Delta");
            Stop(ownServers);
            return;
        }
        WaitFor(Voice + "/health", 90, "Warming up her voice...");

        string edge = FindEdge();
        if (edge == null)
        {
            splash.Close();
            MessageBox.Show("Couldn't find Microsoft Edge, which Delta's window uses.", "Delta");
            Stop(ownServers);
            return;
        }
        string profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"DeltaApp\window");
        Process window = Process.Start(new ProcessStartInfo(edge,
            "--app=" + Gatekeeper.Replace("127.0.0.1", "localhost") + "/app/ " +
            "--user-data-dir=" + Quote(profile) + " --window-size=1200,820 --no-first-run --no-default-browser-check " +
            "--autoplay-policy=no-user-gesture-required"));
        splash.Close();

        window.WaitForExit(); // her window closed
        Stop(ownServers);
    }

    // Puts her to sleep properly (she finishes any note and saves everything), then stops what we started.
    static void Stop(bool ownServers)
    {
        if (!ownServers) return;
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(Gatekeeper + "/owner/sleep-and-close");
            request.Method = "POST";
            request.ContentLength = 0;
            request.Timeout = 5000;
            request.GetResponse().Close();
        }
        catch { }
        foreach (Process p in started)
        {
            try
            {
                if (p.ProcessName == "node" && p.WaitForExit(10000)) continue; // the gatekeeper exits by itself
                if (!p.HasExited) p.Kill();
            }
            catch { }
        }
    }

    static void Start(string name, string exe, string args)
    {
        var info = new ProcessStartInfo(exe, args)
        {
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        var log = new StreamWriter(Path.Combine(Path.GetTempPath(), "delta-app-" + name + ".log"), false) { AutoFlush = true };
        var process = new Process { StartInfo = info };
        DataReceivedEventHandler write = (s, e) => { if (e.Data != null) lock (log) log.WriteLine(e.Data); };
        process.OutputDataReceived += write;
        process.ErrorDataReceived += write;
        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        started.Add(process);
    }

    static bool WaitFor(string url, int seconds, string message)
    {
        Say(message);
        for (int i = 0; i < seconds * 2; i++)
        {
            if (Alive(url)) return true;
            for (int j = 0; j < 5; j++) { Application.DoEvents(); Thread.Sleep(100); }
        }
        return false;
    }

    static bool Alive(string url)
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(url);
            request.Timeout = 1000;
            using (var response = (HttpWebResponse)request.GetResponse()) return response.StatusCode == HttpStatusCode.OK;
        }
        catch { return false; }
    }

    static string FindNode()
    {
        foreach (string dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            try
            {
                string candidate = Path.Combine(dir.Trim(), "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch { }
        }
        return @"C:\Program Files\nodejs\node.exe";
    }

    static string FindEdge()
    {
        foreach (RegistryKey hive in new[] { Registry.LocalMachine, Registry.CurrentUser })
        {
            using (RegistryKey key = hive.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe"))
            {
                string path = key == null ? null : key.GetValue("") as string;
                if (path != null && File.Exists(path)) return path;
            }
        }
        foreach (string path in new[] {
            @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            @"C:\Program Files\Microsoft\Edge\Application\msedge.exe" })
        {
            if (File.Exists(path)) return path;
        }
        return null;
    }

    static string Quote(string s) { return "\"" + s + "\""; }

    static void Say(string text)
    {
        status.Text = text;
        Application.DoEvents();
    }

    // A small "waking up" card while her servers start.
    static Form Splash()
    {
        var form = new Form
        {
            FormBorderStyle = FormBorderStyle.None,
            StartPosition = FormStartPosition.CenterScreen,
            Size = new Size(340, 120),
            BackColor = Color.FromArgb(251, 247, 242),
            ShowInTaskbar = true,
            Text = "Delta",
        };
        try { form.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        var picture = new PictureBox
        {
            Image = form.Icon != null ? new Icon(form.Icon, 64, 64).ToBitmap() : null,
            SizeMode = PictureBoxSizeMode.Zoom,
            Bounds = new Rectangle(20, 28, 64, 64),
        };
        var name = new Label
        {
            Text = "Delta",
            Font = new Font("Segoe UI", 14, FontStyle.Bold),
            ForeColor = Color.FromArgb(29, 27, 38),
            Bounds = new Rectangle(100, 30, 220, 30),
        };
        status = new Label
        {
            Font = new Font("Segoe UI", 10),
            ForeColor = Color.FromArgb(107, 102, 118),
            Bounds = new Rectangle(100, 62, 230, 24),
        };
        form.Controls.AddRange(new Control[] { picture, name, status });
        return form;
    }
}
