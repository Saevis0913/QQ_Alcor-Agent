using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using System.Xml.Linq;
using Microsoft.Win32.SafeHandles;

internal static class AgentUpdate {
    private const string Stamp = ".alcor-message-rc2";
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
    private static readonly string[] Allowed = { "src/app.js", "src/onebot.js", "src/routes.js", "src/sender.js",
        "src/store.js", "ui/app/04-archive-usage.js", "src/pending-message-sends.js" };

    [DllImport("ktmw32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern SafeFileHandle CreateTransaction(IntPtr sa, IntPtr id, uint options, uint isolation, uint flags, uint timeout, string description);
    [DllImport("ktmw32.dll", SetLastError=true)] private static extern bool CommitTransaction(SafeFileHandle tx);
    [DllImport("ktmw32.dll", SetLastError=true)] private static extern bool RollbackTransaction(SafeFileHandle tx);
    [DllImport("kernel32.dll", ExactSpelling=true, CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern SafeFileHandle CreateFileTransactedW(string name, uint access, uint share, IntPtr security,
        uint disposition, uint attrs, IntPtr template, SafeFileHandle tx, IntPtr view, IntPtr extra);
    [DllImport("kernel32.dll", ExactSpelling=true, CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool DeleteFileTransactedW(string path, SafeFileHandle tx);
    [StructLayout(LayoutKind.Sequential)] private struct FileInfoWin {
        public uint Attr, CreatedLow, CreatedHigh, AccessLow, AccessHigh, WriteLow, WriteHigh,
            Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfoWin info);

    private static void Check(bool ok, string why) { if (!ok) throw new InvalidDataException(why); }
    private static string Hash(byte[] data) {
        if (data == null) return "-";
        using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(data)).Replace("-","").ToLowerInvariant();
    }
    private static void RejectLinks(string path) {
        for (string name = path; name != null; name = Path.GetDirectoryName(name)) {
            try { Check((File.GetAttributes(name) & FileAttributes.ReparsePoint) == 0, "目标路径含重解析点，请选择实际安装目录。"); }
            catch (FileNotFoundException) {} catch (DirectoryNotFoundException) {}
        }
    }
    private static byte[] Read(string name) {
        RejectLinks(name);
        try {
            Check(new FileInfo(name).Length <= 4000000, "程序文件大小超出预期。");
            return File.ReadAllBytes(name);
        } catch (FileNotFoundException) { return null; }
    }
    private static string At(string app, XElement f) { return Path.Combine(app, ((string)f.Attribute("path")).Replace('/', '\\')); }
    private static bool Matches(string app, XElement profile, string field) {
        return profile.Elements("file").All(f => Hash(Read(At(app,f))) == (string)f.Attribute(field));
    }
    private static byte[] Build(byte[] before, XElement ops, string targetHash) {
        if (targetHash == "-") return null;
        using (var output = new MemoryStream()) {
            foreach (var op in ops.Elements()) {
                if (op.Name == "copy") {
                    int i=(int)op.Attribute("at"), n=(int)op.Attribute("n");
                    output.Write(before,i,n);
                } else {
                    Check(op.Name=="bytes","无效的内置更新数据。");
                    var bytes=Convert.FromBase64String(op.Value); output.Write(bytes,0,bytes.Length);
                }
            }
            var result=output.ToArray(); Check(Hash(result)==targetHash,"计算的输出哈希不匹配。"); return result;
        }
    }
    private static void Put(SafeFileHandle tx,string file,byte[] previous,byte[] next) {
        RejectLinks(file);
        // OPEN_EXISTING for a known file; CREATE_NEW for a path verified absent.
        using(var handle=CreateFileTransactedW(file,0xc0000000,0,IntPtr.Zero,previous==null?1u:3u,0x80,IntPtr.Zero,tx,IntPtr.Zero,IntPtr.Zero)) {
            if(handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "无法锁定事务文件 " + Path.GetFileName(file));
            FileInfoWin info;
            if(!GetFileInformationByHandle(handle,out info)) throw new Win32Exception();
            Check(info.Links==1 && (info.Attr & 0x400)==0,"目标文件是链接，已中止。");
            using(var stream=new FileStream(handle,FileAccess.ReadWrite)) {
                if(previous!=null) {
                    Check(stream.Length==previous.Length,"校验后文件长度已变化。");
                    var actual=new byte[previous.Length]; int offset=0;
                    while(offset<actual.Length){int n=stream.Read(actual,offset,actual.Length-offset); if(n==0)throw new EndOfStreamException();offset+=n;}
                    Check(actual.SequenceEqual(previous),"校验后程序文件已变化。");
                }
                if(next!=null){stream.Position=0;stream.SetLength(0);stream.Write(next,0,next.Length);stream.Flush();}
            }
        }
        if(next==null && !DeleteFileTransactedW(file,tx))throw new Win32Exception();
    }
    private static void RefuseRunning(string root) {
        var executables=new[]{Path.Combine(root,"Alcor Agent.exe"),Path.Combine(root,@"runtime\node.exe")};
        foreach(var name in new[]{"Alcor Agent","node"}) foreach(var process in Process.GetProcessesByName(name)) {
            using(process) {
                string full;
                try { full=process.MainModule.FileName; } catch(InvalidOperationException){continue;} catch(Win32Exception){continue;}
                Check(!executables.Contains(full,StringComparer.OrdinalIgnoreCase), "请先正常退出此目录的 Agent 和 Alcor 核心，再执行更新或回退。");
            }
        }
        foreach(var dataDir in Directory.EnumerateDirectories(root,"data*")) {
            var lockFile=Path.Combine(dataDir,"alcor-agent.lock"); if(!File.Exists(lockFile))continue;
            RejectLinks(lockFile); int pid;
            if(int.TryParse(File.ReadAllText(lockFile).Trim(),out pid) && pid>0) {
                try {using(var p=Process.GetProcessById(pid)){Check(p.HasExited,"当前数据目录仍有活动进程，请先正常退出。");}}
                catch(ArgumentException){}
            }
        }
    }
    private static XElement Profile(string app, XElement catalog, out bool installed) {
        var stamp=Read(Path.Combine(app,Stamp)); installed=stamp!=null;
        foreach(var p in catalog.Elements("profile")) {
            var files=p.Elements("file").Select(f=>(string)f.Attribute("path")).ToArray();
            Check(files.SequenceEqual(Allowed),"内置文件清单异常。");
            if(installed && !stamp.SequenceEqual(Tag(p)))continue;
            if(Matches(app,p,installed?"after":"before")) return p;
        }
        throw new InvalidDataException("7 个目标文件未匹配此包支持的 as.5 基线，或状态记录与文件不一致。没有覆盖文件。");
    }
    private static byte[] Tag(XElement p) {return Utf8.GetBytes("alcor-agent-receipts-rc2\n"+(string)p.Attribute("id")+"\n");}
    private static void Run(string mode,string directory) {
        var root=Path.GetFullPath(directory);
        Check(!root.StartsWith(@"\\") && !String.Equals(root.TrimEnd('\\'),Path.GetPathRoot(root).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase),
            "请选择本地 Alcor 安装目录。");
        var app=Path.Combine(root,@"resources\app"); RejectLinks(app);
        var exe=Path.Combine(root,"Alcor Agent.exe"); var node=Path.Combine(root,@"runtime\node.exe");
        RejectLinks(exe); RejectLinks(node);
        Check(File.Exists(exe) && File.Exists(node),"请选择包含 Alcor Agent.exe 和 runtime 的安装根目录。");
        if(mode=="observe") {
            var script=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"observe.mjs");
            using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("Alcor.observer"))
            using(var copy=new MemoryStream()) {
                stream.CopyTo(copy);
                Check(Hash(Read(script))==Hash(copy.ToArray()),"现场核对脚本与此版本不符，请重新解压完整验证包。");
            }
            var start=new ProcessStartInfo(node, "\"" + script + "\" \"" + root.TrimEnd('\\') + "\"");
            start.UseShellExecute=false;
            foreach(var env in new[]{"NODE_OPTIONS","NODE_PATH","ELECTRON_RUN_AS_NODE"}) start.EnvironmentVariables.Remove(env);
            using(var child=Process.Start(start)){child.WaitForExit();Check(child.ExitCode==0,"现场核对未完成。");}
            return;
        }
        var pkg=Read(Path.Combine(app,"package.json"));
        Check(pkg!=null && Regex.IsMatch(Utf8.GetString(pkg),@"""version""\s*:\s*""0\.3\.2-as\.5"""), "此包适用于 Alcor Agent 0.3.2-as.5。");
        XElement catalog;
        using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("Alcor.deltas")) catalog=XElement.Load(stream);
        bool installed; var p=Profile(app,catalog,out installed);
        Console.WriteLine("程序基线 {0}，7/7 文件符合预期，状态 {1}。",p.Attribute("id").Value,installed?"RC2":"原基线");
        if(mode=="check" || (mode=="apply")==installed) return;
        RefuseRunning(root);
        using(var guiGate=File.Open(exe,FileMode.Open,FileAccess.Read,FileShare.None))
        using(var nodeGate=File.Open(node,FileMode.Open,FileAccess.Read,FileShare.None))
        using(var tx=CreateTransaction(IntPtr.Zero,IntPtr.Zero,0,0,0,60000,"Alcor Agent RC2 public message files")) {
            if(tx.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error(),"此卷无法建立文件事务。");
            bool committed=false;
            try {
                bool again; var current=Profile(app,catalog,out again);
                Check(again==installed && current==p,"安装目录状态已变化。");
                foreach(var f in p.Elements("file")) {
                    var file=At(app,f); var before=Read(file);
                    Check(Hash(before)==(string)f.Attribute(installed?"after":"before"),"文件在更新前发生变化。");
                    var next=Build(before,f.Element(installed?"reverse":"forward"),(string)f.Attribute(installed?"before":"after"));
                    Put(tx,file,before,next);
                }
                Put(tx,Path.Combine(app,Stamp),installed?Tag(p):null,installed?null:Tag(p));
                if(!CommitTransaction(tx))throw new Win32Exception(Marshal.GetLastWin32Error(),"提交文件事务失败。");
                committed=true;
            } finally {if(!committed)RollbackTransaction(tx);}
        }
        bool final;var verified=Profile(app,catalog,out final);
        Check(final!=installed && verified==p,"提交后的哈希校验异常，请运行 check。");
        Console.WriteLine(final?"已安装 RC2，提交后 7/7 文件校验通过。":"已回到安装前的程序文件，7/7 校验通过。");
    }
    [STAThread] private static int Main(string[] args) {
        try {
            Console.OutputEncoding=Encoding.UTF8;
            string mode=args.Length>0?args[0]:"check";
            Check(new[]{"check","apply","rollback","observe"}.Contains(mode) && args.Length<=2,"用法：Alcor-RC2.exe check|apply|rollback|observe [安装目录]");
            string dir=args.Length==2?args[1]:null;
            if(dir==null)using(var picker=new FolderBrowserDialog()){
                picker.Description="选择已安装的 Alcor Agent 0.3.2-as.5 根目录";picker.ShowNewFolderButton=false;
                if(picker.ShowDialog()!=DialogResult.OK)return 2;dir=picker.SelectedPath;
            }
            Run(mode,dir);return 0;
        } catch(Exception e){
            var win=e as Win32Exception;
            Console.Error.WriteLine("操作未完成。"+e.Message+(win==null?" (0x"+e.HResult.ToString("x8")+")":" (Win32 "+win.NativeErrorCode+")"));return 1;
        }
    }
}
