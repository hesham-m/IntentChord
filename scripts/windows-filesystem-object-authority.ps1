param([switch]$SelfTest,[switch]$SingleRequest)

$ErrorActionPreference = 'Stop'

$IntentChordUtf8ProtocolEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $IntentChordUtf8ProtocolEncoding
[Console]::OutputEncoding = $IntentChordUtf8ProtocolEncoding
$OutputEncoding = $IntentChordUtf8ProtocolEncoding

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

public sealed class AuthorityIdentity {
    public string device_id { get; set; }
    public string file_id { get; set; }
    public string proof_method { get; set; }
}

public sealed class AuthorityChild {
    public string name { get; set; }
    public string object_type { get; set; }
    public AuthorityIdentity identity { get; set; }
    public long? size_bytes { get; set; }
    public long? mode { get; set; }
    public long? modified_at_ms { get; set; }
    public long? created_at_ms { get; set; }
    public string boundary_code { get; set; }
}

public sealed class AuthorityResult {
    public bool ok { get; set; }
    public string code { get; set; }
    public string message { get; set; }
    public string resolved_real_path { get; set; }
    public AuthorityIdentity identity { get; set; }
    public AuthorityChild[] entries { get; set; }
    public string content_hash { get; set; }
    public long? bytes_read { get; set; }
    public string prefix_base64 { get; set; }
    public bool? prefix_complete_file { get; set; }
    public long? line_count { get; set; }
}

public static class IntentChordFilesystemAuthority {
    private const uint FILE_READ_DATA_OR_LIST_DIRECTORY = 0x0001;
    private const uint FILE_READ_ATTRIBUTES = 0x0080;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint FILE_SHARE_DELETE = 0x00000004;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_OPEN = 1;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
    private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
    private const uint FILE_NAME_NORMALIZED = 0x0;
    private const uint VOLUME_NAME_DOS = 0x0;
    private const uint FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
    private const uint FILE_NON_DIRECTORY_FILE = 0x00000040;
    private const uint NT_FILE_OPEN_REPARSE_POINT = 0x00200000;
    private const uint OBJ_CASE_INSENSITIVE = 0x00000040;
    private const int FileNamesInformation = 12;
    private const int STATUS_NO_MORE_FILES = unchecked((int)0x80000006);
    private const long JS_MAX_SAFE_INTEGER = 9007199254740991L;

    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION {
        public uint dwFileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME ftCreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME ftLastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME ftLastWriteTime;
        public uint dwVolumeSerialNumber;
        public uint nFileSizeHigh;
        public uint nFileSizeLow;
        public uint nNumberOfLinks;
        public uint nFileIndexHigh;
        public uint nFileIndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILE_ID_128 { public ulong Part0; public ulong Part1; }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILE_ID_INFO { public ulong VolumeSerialNumber; public FILE_ID_128 FileId; }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_STATUS_BLOCK { public IntPtr Status; public UIntPtr Information; }

    [StructLayout(LayoutKind.Sequential)]
    private struct UNICODE_STRING { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }

    [StructLayout(LayoutKind.Sequential)]
    private struct OBJECT_ATTRIBUTES {
        public int Length;
        public IntPtr RootDirectory;
        public IntPtr ObjectName;
        public uint Attributes;
        public IntPtr SecurityDescriptor;
        public IntPtr SecurityQualityOfService;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string lpFileName,uint dwDesiredAccess,uint dwShareMode,IntPtr lpSecurityAttributes,uint dwCreationDisposition,uint dwFlagsAndAttributes,IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle hFile,out BY_HANDLE_FILE_INFORMATION lpFileInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle hFile,int FileInformationClass,out FILE_ID_INFO lpFileInformation,uint dwBufferSize);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle hFile,System.Text.StringBuilder lpszFilePath,uint cchFilePath,uint dwFlags);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryDirectoryFile(SafeFileHandle FileHandle,IntPtr Event,IntPtr ApcRoutine,IntPtr ApcContext,out IO_STATUS_BLOCK IoStatusBlock,IntPtr FileInformation,uint Length,int FileInformationClass,[MarshalAs(UnmanagedType.Bool)] bool ReturnSingleEntry,IntPtr FileName,[MarshalAs(UnmanagedType.Bool)] bool RestartScan);

    [DllImport("ntdll.dll")]
    private static extern int NtCreateFile(out IntPtr FileHandle,uint DesiredAccess,ref OBJECT_ATTRIBUTES ObjectAttributes,out IO_STATUS_BLOCK IoStatusBlock,IntPtr AllocationSize,uint FileAttributes,uint ShareAccess,uint CreateDisposition,uint CreateOptions,IntPtr EaBuffer,uint EaLength);

    private static bool NtSuccess(int status) { return status >= 0; }

    private static SafeFileHandle OpenDirectory(string path) {
        SafeFileHandle handle = CreateFileW(path,FILE_READ_DATA_OR_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,IntPtr.Zero,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,IntPtr.Zero);
        if (handle == null || handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateFileW failed for Workspace directory authority proof.");
        BY_HANDLE_FILE_INFORMATION info;
        Identity(handle, out info, true);
        if ((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) { handle.Dispose(); throw new InvalidOperationException("WORKSPACE_ROOT_NOT_DIRECTORY"); }
        return handle;
    }

    private static SafeFileHandle OpenRelative(SafeFileHandle parent, string childName, bool requireDirectory, bool requireFile) {
        if (String.IsNullOrEmpty(childName) || childName == "." || childName == ".." || childName.IndexOf('\\') >= 0 || childName.IndexOf('/') >= 0 || childName.IndexOf(':') >= 0 || childName.IndexOf('\0') >= 0) {
            throw new InvalidOperationException("WORKSPACE_SOURCE_RELATIVE_PATH_INVALID");
        }
        IntPtr stringBuffer = IntPtr.Zero;
        IntPtr unicodePtr = IntPtr.Zero;
        try {
            stringBuffer = Marshal.StringToHGlobalUni(childName);
            UNICODE_STRING unicode = new UNICODE_STRING();
            unicode.Length = checked((ushort)(childName.Length * 2));
            unicode.MaximumLength = checked((ushort)((childName.Length + 1) * 2));
            unicode.Buffer = stringBuffer;
            unicodePtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));
            Marshal.StructureToPtr(unicode, unicodePtr, false);
            OBJECT_ATTRIBUTES attrs = new OBJECT_ATTRIBUTES();
            attrs.Length = Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES));
            attrs.RootDirectory = parent.DangerousGetHandle();
            attrs.ObjectName = unicodePtr;
            attrs.Attributes = OBJ_CASE_INSENSITIVE;
            IO_STATUS_BLOCK io;
            IntPtr raw;
            uint options = NT_FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT;
            if (requireDirectory) options |= 0x00000001;
            if (requireFile) options |= FILE_NON_DIRECTORY_FILE;
            int status = NtCreateFile(out raw,FILE_READ_DATA_OR_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,ref attrs,out io,IntPtr.Zero,0,FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,FILE_OPEN,options,IntPtr.Zero,0);
            if (!NtSuccess(status) || raw == IntPtr.Zero || raw == new IntPtr(-1)) throw new InvalidOperationException("WORKSPACE_RELATIVE_CHILD_OPEN_NTSTATUS_0x" + unchecked((uint)status).ToString("X8"));
            return new SafeFileHandle(raw, true);
        }
        finally {
            if (unicodePtr != IntPtr.Zero) Marshal.FreeHGlobal(unicodePtr);
            if (stringBuffer != IntPtr.Zero) Marshal.FreeHGlobal(stringBuffer);
        }
    }

    private static AuthorityIdentity Identity(SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION info, bool rejectReparse) {
        if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error(), "GetFileInformationByHandle failed.");
        if (rejectReparse && (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) throw new InvalidOperationException("WORKSPACE_DIRECTORY_REPARSE_POINT");
        FILE_ID_INFO idInfo;
        if (!GetFileInformationByHandleEx(handle,18,out idInfo,(uint)Marshal.SizeOf(typeof(FILE_ID_INFO)))) throw new Win32Exception(Marshal.GetLastWin32Error(), "GetFileInformationByHandleEx(FileIdInfo) failed.");
        if (idInfo.FileId.Part0 == 0UL && idInfo.FileId.Part1 == 0UL) throw new InvalidOperationException("WORKSPACE_OBJECT_IDENTITY_UNPROVABLE");
        string fileId = idInfo.FileId.Part0.ToString("x16",System.Globalization.CultureInfo.InvariantCulture) + idInfo.FileId.Part1.ToString("x16",System.Globalization.CultureInfo.InvariantCulture);
        return new AuthorityIdentity { device_id=idInfo.VolumeSerialNumber.ToString(System.Globalization.CultureInfo.InvariantCulture), file_id=fileId, proof_method="WINDOWS_FILE_ID_128_V1" };
    }

    private static bool SameIdentity(AuthorityIdentity left, string device, string file) {
        return left != null && String.Equals(left.device_id,device,StringComparison.Ordinal) && String.Equals(left.file_id,file,StringComparison.Ordinal);
    }

    private static string FinalPath(SafeFileHandle handle) {
        System.Text.StringBuilder builder = new System.Text.StringBuilder(32768);
        uint length = GetFinalPathNameByHandleW(handle,builder,(uint)builder.Capacity,FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
        if (length == 0 || length >= builder.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error(), "GetFinalPathNameByHandleW failed.");
        string result = builder.ToString();
        if (result.StartsWith(@"\\?\UNC\",StringComparison.OrdinalIgnoreCase)) return @"\\" + result.Substring(8);
        if (result.StartsWith(@"\\?\",StringComparison.OrdinalIgnoreCase)) return result.Substring(4);
        return result;
    }

    private static long FileTimeMilliseconds(System.Runtime.InteropServices.ComTypes.FILETIME ft) {
        long ticks = ((long)(uint)ft.dwHighDateTime << 32) | (uint)ft.dwLowDateTime;
        return new DateTime(ticks, DateTimeKind.Utc).Subtract(new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).Ticks / TimeSpan.TicksPerMillisecond;
    }

    private static long FileSize(BY_HANDLE_FILE_INFORMATION info) {
        ulong size = ((ulong)info.nFileSizeHigh << 32) | (ulong)info.nFileSizeLow;
        if (size > (ulong)JS_MAX_SAFE_INTEGER) throw new InvalidOperationException("WORKSPACE_FILE_SIZE_UNREPRESENTABLE");
        return (long)size;
    }

    private static string[] SplitRelative(string value) {
        if (String.IsNullOrWhiteSpace(value) || value == ".") return new string[0];
        string normalized = value.Replace('\\','/').Trim('/');
        string[] parts = normalized.Split(new char[] {'/'}, StringSplitOptions.RemoveEmptyEntries);
        foreach (string part in parts) if (part == "." || part == ".." || part.IndexOf(':') >= 0 || part.IndexOf('\0') >= 0) throw new InvalidOperationException("WORKSPACE_SOURCE_RELATIVE_PATH_INVALID");
        return parts;
    }

    private static SafeFileHandle OpenVerifiedRoot(string path, string expectedDeviceId, string expectedFileId) {
        SafeFileHandle root = OpenDirectory(path);
        BY_HANDLE_FILE_INFORMATION info;
        AuthorityIdentity identity = Identity(root,out info,true);
        if (!SameIdentity(identity,expectedDeviceId,expectedFileId)) { root.Dispose(); throw new InvalidOperationException("WORKSPACE_ROOT_AUTHORITY_CHANGED"); }
        return root;
    }

    private static SafeFileHandle TraverseDirectory(SafeFileHandle verifiedRoot, string relativePath) {
        SafeFileHandle current = verifiedRoot;
        bool ownsCurrent = false;
        try {
            foreach (string segment in SplitRelative(relativePath)) {
                SafeFileHandle child = OpenRelative(current,segment,true,false);
                BY_HANDLE_FILE_INFORMATION info;
                Identity(child,out info,true);
                if ((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) { child.Dispose(); throw new InvalidOperationException("WORKSPACE_DIRECTORY_OBJECT_IDENTITY_CHANGED"); }
                if (ownsCurrent) current.Dispose();
                current = child;
                ownsCurrent = true;
            }
            return current;
        }
        catch {
            if (ownsCurrent) current.Dispose();
            throw;
        }
    }

    private static string[] EnumerateSameHandle(SafeFileHandle handle) {
        return EnumerateSameHandle(handle,-1L,0,false);
    }

    private static string[] EnumerateSameHandle(SafeFileHandle handle,long deadlineEpochMs,int batchDelayMs,bool emitProgress) {
        List<string> names = new List<string>();
        const int bufferSize = 64 * 1024;
        IntPtr buffer = Marshal.AllocHGlobal(bufferSize);
        try {
            bool restart = true;
            while (true) {
                if (deadlineEpochMs >= 0 && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= deadlineEpochMs) throw new InvalidOperationException("WORKSPACE_INDEX_TIMEOUT");
                IO_STATUS_BLOCK io;
                int status = NtQueryDirectoryFile(handle,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,out io,buffer,(uint)bufferSize,FileNamesInformation,false,IntPtr.Zero,restart);
                restart = false;
                if (status == STATUS_NO_MORE_FILES) break;
                if (status < 0) throw new InvalidOperationException("WORKSPACE_DIRECTORY_ENUMERATION_NTSTATUS_0x" + unchecked((uint)status).ToString("X8"));
                if (batchDelayMs > 0) System.Threading.Thread.Sleep(batchDelayMs);
                if (deadlineEpochMs >= 0 && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= deadlineEpochMs) throw new InvalidOperationException("WORKSPACE_INDEX_TIMEOUT");
                int offset = 0;
                int batchEntries = 0;
                while (true) {
                    int next = Marshal.ReadInt32(buffer,offset + 0);
                    int nameLength = Marshal.ReadInt32(buffer,offset + 8);
                    if (nameLength < 0 || nameLength > bufferSize - offset - 12 || (nameLength % 2) != 0) throw new InvalidOperationException("WORKSPACE_DIRECTORY_ENUMERATION_BUFFER_INVALID");
                    string name = Marshal.PtrToStringUni(IntPtr.Add(buffer,offset + 12),nameLength / 2) ?? "";
                    if (name != "." && name != ".." && name.Length > 0) { names.Add(name); batchEntries += 1; }
                    if (next == 0) break;
                    if (next < 12 || offset + next >= bufferSize) throw new InvalidOperationException("WORKSPACE_DIRECTORY_ENUMERATION_OFFSET_INVALID");
                    offset += next;
                }
                if (emitProgress && batchEntries > 0) {
                    Console.Out.WriteLine("{\"progress_entries\":" + batchEntries.ToString(System.Globalization.CultureInfo.InvariantCulture) + "}");
                    Console.Out.Flush();
                }
            }
        }
        finally { Marshal.FreeHGlobal(buffer); }
        names.Sort(StringComparer.OrdinalIgnoreCase);
        return names.ToArray();
    }

    private static AuthorityChild DescribeChild(SafeFileHandle parent, string name) {
        using (SafeFileHandle child = OpenRelative(parent,name,false,false)) {
            BY_HANDLE_FILE_INFORMATION info;
            AuthorityIdentity identity = Identity(child,out info,false);
            if ((info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return new AuthorityChild { name=name, object_type="BOUNDARY", boundary_code="REPARSE_POINT_NOT_FOLLOWED" };
            bool directory = (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
            return new AuthorityChild {
                name=name,
                object_type=directory ? "DIRECTORY" : "FILE",
                identity=identity,
                size_bytes=FileSize(info),
                mode=(long)info.dwFileAttributes,
                modified_at_ms=FileTimeMilliseconds(info.ftLastWriteTime),
                created_at_ms=FileTimeMilliseconds(info.ftCreationTime),
            };
        }
    }

    public static AuthorityResult Probe(string path) {
        try {
            using (SafeFileHandle handle = OpenDirectory(path)) {
                BY_HANDLE_FILE_INFORMATION info;
                AuthorityIdentity identity = Identity(handle,out info,true);
                return new AuthorityResult { ok=true, code="PASS", message="", resolved_real_path=FinalPath(handle), identity=identity, entries=new AuthorityChild[0] };
            }
        }
        catch (Exception ex) { return Failure(ex); }
    }

    public static AuthorityResult EnumerateRelative(string rootPath,string expectedDeviceId,string expectedFileId,string relativePath,string expectedChildDeviceId,string expectedChildFileId,long deadlineEpochMs,int batchDelayMs,bool emitProgress) {
        try {
            if (deadlineEpochMs >= 0 && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= deadlineEpochMs) throw new InvalidOperationException("WORKSPACE_INDEX_TIMEOUT");
            using (SafeFileHandle root = OpenVerifiedRoot(rootPath,expectedDeviceId,expectedFileId)) {
                SafeFileHandle directory = TraverseDirectory(root,relativePath);
                bool disposeDirectory = !Object.ReferenceEquals(directory,root);
                try {
                    BY_HANDLE_FILE_INFORMATION beforeInfo;
                    AuthorityIdentity identity = Identity(directory,out beforeInfo,true);
                    if (!String.IsNullOrEmpty(expectedChildFileId) && !SameIdentity(identity,expectedChildDeviceId,expectedChildFileId)) throw new InvalidOperationException("WORKSPACE_DIRECTORY_OBJECT_IDENTITY_CHANGED");
                    string[] names = EnumerateSameHandle(directory,deadlineEpochMs,batchDelayMs,emitProgress);
                    List<AuthorityChild> children = new List<AuthorityChild>();
                    foreach (string name in names) {
                        if (deadlineEpochMs >= 0 && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= deadlineEpochMs) throw new InvalidOperationException("WORKSPACE_INDEX_TIMEOUT");
                        children.Add(DescribeChild(directory,name));
                    }
                    BY_HANDLE_FILE_INFORMATION afterInfo;
                    AuthorityIdentity after = Identity(directory,out afterInfo,true);
                    if (!SameIdentity(after,identity.device_id,identity.file_id)) throw new InvalidOperationException("WORKSPACE_DIRECTORY_OBJECT_IDENTITY_CHANGED");
                    return new AuthorityResult { ok=true, code="PASS", message="", resolved_real_path=FinalPath(directory), identity=identity, entries=children.ToArray() };
                }
                finally { if (disposeDirectory) directory.Dispose(); }
            }
        }
        catch (Exception ex) { return Failure(ex); }
    }

    public static AuthorityResult CaptureRelative(string rootPath,string expectedDeviceId,string expectedFileId,string relativePath,string expectedChildDeviceId,string expectedChildFileId,long expectedSize,int maxPrefixBytes,bool countLines,long deadlineEpochMs,long maxReadBytes,string byteBudgetCode,int startupDelayMs,int chunkDelayMs,int responseDelayMs,bool emitProgress) {
        try {
            if (startupDelayMs > 0) System.Threading.Thread.Sleep(startupDelayMs);
            if (deadlineEpochMs >= 0 && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= deadlineEpochMs) throw new InvalidOperationException("WORKSPACE_INDEX_TIMEOUT");
            string[] segments = SplitRelative(relativePath);
            if (segments.Length == 0) throw new InvalidOperationException("WORKSPACE_CAPTURE_RELATIVE_FILE_REQUIRED");
            string fileName = segments[segments.Length - 1];
            string parentRelative = segments.Length <= 1 ? "" : String.Join("/",segments,0,segments.Length - 1);
            using (SafeFileHandle root = OpenVerifiedRoot(rootPath,expectedDeviceId,expectedFileId)) {
                SafeFileHandle parent = TraverseDirectory(root,parentRelative);
                bool disposeParent = !Object.ReferenceEquals(parent,root);
                try {
                    using (SafeFileHandle file = OpenRelative(parent,fileName,false,true)) {
                        BY_HANDLE_FILE_INFORMATION beforeInfo;
                        AuthorityIdentity identity = Identity(file,out beforeInfo,false);
                        if ((beforeInfo.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) throw new InvalidOperationException("WORKSPACE_SOURCE_PATH_SUBSTITUTION");
                        if ((beforeInfo.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) throw new InvalidOperationException("WORKSPACE_SOURCE_OBJECT_TYPE_CHANGED");
                        if (!String.IsNullOrEmpty(expectedChildFileId) && !SameIdentity(identity,expectedChildDeviceId,expectedChildFileId)) throw new InvalidOperationException("WORKSPACE_SOURCE_OBJECT_IDENTITY_CHANGED");
                        long size = FileSize(beforeInfo);
                        if (expectedSize >= 0 && size != expectedSize) throw new InvalidOperationException("WORKSPACE_SOURCE_OBJECT_SIZE_CHANGED");
                        SHA256 sha = SHA256.Create();
                        MemoryStream prefix = new MemoryStream();
                        long total = 0;
                        long newlines = 0;
                        byte[] buffer = new byte[64 * 1024];
                        using (FileStream stream = new FileStream(file,FileAccess.Read,64 * 1024,false)) {
                            while (true) {
                                if (deadlineEpochMs >= 0 && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= deadlineEpochMs) throw new InvalidOperationException("WORKSPACE_INDEX_TIMEOUT");
                                int requested = buffer.Length;
                                if (maxReadBytes >= 0) {
                                    long remainingBudget = maxReadBytes - total;
                                    if (remainingBudget < 0) throw new InvalidOperationException(String.IsNullOrEmpty(byteBudgetCode) ? "WORKSPACE_CAPTURE_BYTE_BUDGET_EXCEEDED" : byteBudgetCode);
                                    requested = (int)Math.Min((long)buffer.Length, remainingBudget + 1L);
                                }
                                if (chunkDelayMs > 0) System.Threading.Thread.Sleep(chunkDelayMs);
                                if (deadlineEpochMs >= 0 && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= deadlineEpochMs) throw new InvalidOperationException("WORKSPACE_INDEX_TIMEOUT");
                                int read = stream.Read(buffer,0,requested);
                                if (read <= 0) break;
                                if (maxReadBytes >= 0 && total + read > maxReadBytes) throw new InvalidOperationException(String.IsNullOrEmpty(byteBudgetCode) ? "WORKSPACE_CAPTURE_BYTE_BUDGET_EXCEEDED" : byteBudgetCode);
                                sha.TransformBlock(buffer,0,read,null,0);
                                total += read;
                                if (total > JS_MAX_SAFE_INTEGER) throw new InvalidOperationException("WORKSPACE_FILE_SIZE_UNREPRESENTABLE");
                                if (emitProgress) {
                                    Console.Out.WriteLine("{\"progress_bytes\":" + read.ToString(System.Globalization.CultureInfo.InvariantCulture) + "}");
                                    Console.Out.Flush();
                                }
                                if (countLines) for (int i=0;i<read;i++) if (buffer[i] == 0x0A) newlines++;
                                int remaining = maxPrefixBytes - (int)prefix.Length;
                                if (remaining > 0) prefix.Write(buffer,0,Math.Min(remaining,read));
                            }
                            sha.TransformFinalBlock(new byte[0],0,0);
                            BY_HANDLE_FILE_INFORMATION afterInfo;
                            AuthorityIdentity after = Identity(file,out afterInfo,false);
                            if (!SameIdentity(after,identity.device_id,identity.file_id)) throw new InvalidOperationException("WORKSPACE_SOURCE_OBJECT_IDENTITY_CHANGED");
                        }
                        string hash = BitConverter.ToString(sha.Hash).Replace("-","").ToLowerInvariant();
                        if (responseDelayMs > 0) System.Threading.Thread.Sleep(responseDelayMs);
                        if (deadlineEpochMs >= 0 && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= deadlineEpochMs) throw new InvalidOperationException("WORKSPACE_INDEX_TIMEOUT");
                        return new AuthorityResult {
                            ok=true, code="PASS", message="", identity=identity,
                            content_hash="sha256:" + hash,
                            bytes_read=total,
                            prefix_base64=Convert.ToBase64String(prefix.ToArray()),
                            prefix_complete_file=prefix.Length == total,
                            line_count=countLines ? (total == 0 ? 0 : newlines + 1) : (long?)null,
                            entries=new AuthorityChild[0]
                        };
                    }
                }
                finally { if (disposeParent) parent.Dispose(); }
            }
        }
        catch (Exception ex) { return Failure(ex); }
    }

    public static AuthorityResult SelfTestSameHandleDirectorySwap(string rootPath,string outsidePath) {
        string displacedPath = rootPath + ".authorized-displaced-" + Guid.NewGuid().ToString("N");
        bool rootMoved=false,outsideMoved=false;
        try {
            using (SafeFileHandle handle = OpenDirectory(rootPath)) {
                BY_HANDLE_FILE_INFORMATION beforeInfo; AuthorityIdentity beforeIdentity=Identity(handle,out beforeInfo,true);
                string[] beforeEntries=EnumerateSameHandle(handle);
                if (Array.IndexOf(beforeEntries,"authorized-marker.txt") < 0) throw new InvalidOperationException("WORKSPACE_WINDOWS_SWAP_SELFTEST_AUTHORIZED_MARKER_MISSING");
                Directory.Move(rootPath,displacedPath); rootMoved=true; Directory.Move(outsidePath,rootPath); outsideMoved=true;
                string[] enumerated=EnumerateSameHandle(handle);
                BY_HANDLE_FILE_INFORMATION afterInfo; AuthorityIdentity afterIdentity=Identity(handle,out afterInfo,true);
                if (!SameIdentity(afterIdentity,beforeIdentity.device_id,beforeIdentity.file_id)) throw new InvalidOperationException("WORKSPACE_DIRECTORY_OBJECT_IDENTITY_CHANGED");
                if (Array.IndexOf(enumerated,"authorized-marker.txt") < 0 || Array.IndexOf(enumerated,"outside-marker.txt") >= 0) throw new InvalidOperationException("WORKSPACE_DIRECTORY_ENUMERATION_REOPENED_MUTABLE_PATH");
                return new AuthorityResult { ok=true,code="PASS",message="same-handle-directory",resolved_real_path=FinalPath(handle),identity=beforeIdentity,entries=new AuthorityChild[0] };
            }
        }
        catch (Exception ex) { return Failure(ex); }
        finally { RestoreSwap(rootPath,outsidePath,displacedPath,rootMoved,outsideMoved); }
    }

    public static AuthorityResult SelfTestRelativeChildRootSwap(string rootPath,string outsidePath) {
        string displacedPath = rootPath + ".child-displaced-" + Guid.NewGuid().ToString("N");
        bool rootMoved=false,outsideMoved=false;
        try {
            using (SafeFileHandle root = OpenDirectory(rootPath)) {
                BY_HANDLE_FILE_INFORMATION rootInfo; AuthorityIdentity rootIdentity=Identity(root,out rootInfo,true);
                string[] names=EnumerateSameHandle(root);
                if (Array.IndexOf(names,"same.txt") < 0) throw new InvalidOperationException("WORKSPACE_WINDOWS_CHILD_SELFTEST_NAME_MISSING");
                Directory.Move(rootPath,displacedPath); rootMoved=true; Directory.Move(outsidePath,rootPath); outsideMoved=true;
                using (SafeFileHandle file = OpenRelative(root,"same.txt",false,true)) {
                    BY_HANDLE_FILE_INFORMATION fileInfo; AuthorityIdentity fileIdentity=Identity(file,out fileInfo,false);
                    if ((fileInfo.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) throw new InvalidOperationException("WORKSPACE_SOURCE_PATH_SUBSTITUTION");
                    string content;
                    using (FileStream stream = new FileStream(file,FileAccess.Read,4096,false)) using (StreamReader reader = new StreamReader(stream)) content=reader.ReadToEnd();
                    if (content != "AUTHORIZED-CHILD") throw new InvalidOperationException("WORKSPACE_CHILD_OPEN_REENTERED_MUTABLE_PATH_NAMESPACE");
                    return new AuthorityResult { ok=true,code="PASS",message="relative-child-root-swap",resolved_real_path=FinalPath(root),identity=rootIdentity,entries=new AuthorityChild[] { new AuthorityChild { name="same.txt",object_type="FILE",identity=fileIdentity } } };
                }
            }
        }
        catch (Exception ex) { return Failure(ex); }
        finally { RestoreSwap(rootPath,outsidePath,displacedPath,rootMoved,outsideMoved); }
    }


    public static AuthorityResult SelfTestRelativeParentSwap(string rootPath,string outsidePath) {
        string srcPath = Path.Combine(rootPath,"src");
        string outsideSrc = Path.Combine(outsidePath,"src-replacement");
        string displaced = Path.Combine(rootPath,"src-authorized-displaced-" + Guid.NewGuid().ToString("N"));
        bool srcMoved=false,outsideMoved=false;
        try {
            Directory.CreateDirectory(srcPath);
            Directory.CreateDirectory(outsideSrc);
            File.WriteAllText(Path.Combine(srcPath,"same.txt"),"AUTHORIZED-PARENT-CHILD");
            File.WriteAllText(Path.Combine(outsideSrc,"same.txt"),"OUTSIDE-PARENT-CHILD");
            using (SafeFileHandle root = OpenDirectory(rootPath))
            using (SafeFileHandle src = OpenRelative(root,"src",true,false)) {
                string[] names = EnumerateSameHandle(src);
                if (Array.IndexOf(names,"same.txt") < 0) throw new InvalidOperationException("WORKSPACE_WINDOWS_PARENT_SELFTEST_NAME_MISSING");
                Directory.Move(srcPath,displaced); srcMoved=true;
                Directory.Move(outsideSrc,srcPath); outsideMoved=true;
                using (SafeFileHandle file = OpenRelative(src,"same.txt",false,true)) {
                    BY_HANDLE_FILE_INFORMATION fileInfo; Identity(file,out fileInfo,false);
                    if ((fileInfo.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) throw new InvalidOperationException("WORKSPACE_SOURCE_PATH_SUBSTITUTION");
                    string content;
                    using (FileStream stream = new FileStream(file,FileAccess.Read,4096,false))
                    using (StreamReader reader = new StreamReader(stream)) content=reader.ReadToEnd();
                    if (content != "AUTHORIZED-PARENT-CHILD") throw new InvalidOperationException("WORKSPACE_PARENT_CHILD_OPEN_REENTERED_MUTABLE_PATH_NAMESPACE");
                }
            }
            return new AuthorityResult { ok=true,code="PASS",message="relative-parent-swap",entries=new AuthorityChild[0] };
        }
        catch (Exception ex) { return Failure(ex); }
        finally {
            try { if (outsideMoved && Directory.Exists(srcPath)) Directory.Move(srcPath,outsideSrc); } catch { }
            try { if (srcMoved && Directory.Exists(displaced) && !Directory.Exists(srcPath)) Directory.Move(displaced,srcPath); } catch { }
        }
    }

    public static AuthorityResult SelfTestRelativeChildIdentitySwap(string rootPath) {
        string filePath = Path.Combine(rootPath,"identity-same.txt");
        string displaced = Path.Combine(rootPath,"identity-authorized-old.txt");
        string replacement = Path.Combine(rootPath,"identity-replacement.txt");
        bool originalMoved=false,replacementMoved=false;
        try {
            File.WriteAllText(filePath,"AUTHORIZED-IDENTITY");
            File.WriteAllText(replacement,"REPLACEMENT-IDENTITY-MUST-NOT-BE-READ");
            using (SafeFileHandle root = OpenDirectory(rootPath)) {
                AuthorityIdentity expected;
                using (SafeFileHandle first = OpenRelative(root,"identity-same.txt",false,true)) {
                    BY_HANDLE_FILE_INFORMATION firstInfo; expected=Identity(first,out firstInfo,false);
                }
                File.Move(filePath,displaced); originalMoved=true;
                File.Move(replacement,filePath); replacementMoved=true;
                using (SafeFileHandle second = OpenRelative(root,"identity-same.txt",false,true)) {
                    BY_HANDLE_FILE_INFORMATION secondInfo; AuthorityIdentity actual=Identity(second,out secondInfo,false);
                    if (SameIdentity(actual,expected.device_id,expected.file_id)) throw new InvalidOperationException("WORKSPACE_WINDOWS_CHILD_REPLACEMENT_IDENTITY_FALSE_MATCH");
                    // A governed caller must reject on identity mismatch before constructing a read stream.
                }
            }
            return new AuthorityResult { ok=true,code="PASS",message="relative-child-identity-swap-rejected-before-read",entries=new AuthorityChild[0] };
        }
        catch (Exception ex) { return Failure(ex); }
        finally {
            try { if (replacementMoved && File.Exists(filePath)) File.Move(filePath,replacement); } catch { }
            try { if (originalMoved && File.Exists(displaced) && !File.Exists(filePath)) File.Move(displaced,filePath); } catch { }
        }
    }

    private static void RestoreSwap(string rootPath,string outsidePath,string displacedPath,bool rootMoved,bool outsideMoved) {
        try { if (outsideMoved && Directory.Exists(rootPath)) Directory.Move(rootPath,outsidePath); } catch { }
        try { if (rootMoved && Directory.Exists(displacedPath) && !Directory.Exists(rootPath)) Directory.Move(displacedPath,rootPath); } catch { }
    }

    private static AuthorityResult Failure(Exception ex) {
        string message=ex.Message ?? "";
        string code=message.StartsWith("WORKSPACE_",StringComparison.Ordinal) ? message : (ex is Win32Exception ? "WORKSPACE_OBJECT_IDENTITY_UNPROVABLE" : "WORKSPACE_FILESYSTEM_AUTHORITY_FAILED");
        return new AuthorityResult { ok=false,code=code,message=message,entries=new AuthorityChild[0] };
    }
}

// Retired: USN FSCTL authority now lives solely in IntentChord.UsnAuthorityService.
// This legacy helper is compiled for non-USN filesystem identity operations only.
#if false
// ==================================================================================
// FSCTL USN JOURNAL READING (STRONG AUTHORITY — SPEC V3 Phase 3)
// Binary USN_RECORD_V2 decoding via DeviceIoControl. Sequence-exact identity.
// fsutil is NEVER used in this path. ':0' placeholder is NEVER emitted.
// ==================================================================================
public static class IntentChordUsnJournalAuthority {
    private const uint IOCTL_USN_QUERY_JOURNAL = 0x000900F4;
    private const uint IOCTL_USN_READ_JOURNAL  = 0x000900BB;
    private const uint GENERIC_READ = 0x80000000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint OPEN_EXISTING_FLAG = 3;
    private const int USN_RECORD_V2_MAJOR_VERSION = 2;
    private const int USN_RECORD_V2_FIXED_SIZE = 60;
    private const int USN_OUTPUT_HEADER_SIZE = 8;
    private const int ERROR_JOURNAL_DELETE_IN_PROGRESS = 1178;
    private const int ERROR_JOURNAL_NOT_ACTIVE = 1179;
    private const int ERROR_JOURNAL_ENTRY_DELETED = 1181;

    [StructLayout(LayoutKind.Sequential)]
    public struct USN_RECORD_V2 {
        public uint RecordLength;
        public ushort MajorVersion;
        public ushort MinorVersion;
        public ulong FileReferenceNumber;
        public ulong ParentFileReferenceNumber;
        public ulong Usn;
        public long TimeStamp;
        public uint Reason;
        public uint SourceInfo;
        public uint SecurityId;
        public uint FileAttributes;
        public ushort FileNameLength;
        public ushort FileNameOffset;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct USN_JOURNAL_DATA {
        public ulong UsnJournalID;
        public ulong FirstUsn;
        public ulong NextUsn;
        public ulong LowestValidUsn;
        public ulong MaxUsn;
        public ulong MaximumSize;
        public ulong AllocationDelta;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 8)]
    public struct READ_USN_JOURNAL_DATA {
        public long StartUsn;
        public uint ReasonMask;
        public uint ReturnOnlyOnClose;
        public ulong Timeout;
        public ulong BytesToWaitFor;
        public ulong UsnJournalID;
        public ushort MinMajorVersion;
        public ushort MaxMajorVersion;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string lpFileName, uint dwDesiredAccess, uint dwShareMode,
        IntPtr lpSecurityAttributes, uint dwCreationDisposition,
        uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeviceIoControl(
        SafeFileHandle hDevice, uint dwIoControlCode,
        IntPtr lpInBuffer, uint nInBufferSize,
        IntPtr lpOutBuffer, uint nOutBufferSize,
        out uint lpBytesReturned, IntPtr lpOverlapped);

    private static SafeFileHandle OpenVolume(string driveLetter) {
        string volPath = "\\\\.\\" + driveLetter.TrimEnd('\\');
        SafeFileHandle h = CreateFileW(volPath, GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING_FLAG, 0, IntPtr.Zero);
        if (h == null || h.IsInvalid)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenVolume failed for USN journal");
        return h;
    }

    public static bool QueryUsnJournal(string driveLetter, out ulong journalId, out ulong firstUsn, out ulong nextUsn, out string error) {
        error = null;
        journalId = 0; firstUsn = 0; nextUsn = 0;
        IntPtr buf = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(USN_JOURNAL_DATA)));
        try {
            using (SafeFileHandle vol = OpenVolume(driveLetter)) {
                uint returned;
                if (!DeviceIoControl(vol, IOCTL_USN_QUERY_JOURNAL, IntPtr.Zero, 0,
                    buf, (uint)Marshal.SizeOf(typeof(USN_JOURNAL_DATA)), out returned, IntPtr.Zero)) {
                    int err = Marshal.GetLastWin32Error();
                    if (err == ERROR_JOURNAL_NOT_ACTIVE || err == ERROR_JOURNAL_DELETE_IN_PROGRESS) {
                        error = "USN_JOURNAL_NOT_ACTIVE"; return false;
                    }
                    throw new Win32Exception(err, "DeviceIoControl FSCTL_QUERY_USN_JOURNAL failed");
                }
                USN_JOURNAL_DATA data = Marshal.PtrToStructure<USN_JOURNAL_DATA>(buf);
                journalId = data.UsnJournalID;
                firstUsn = data.FirstUsn;
                nextUsn = data.NextUsn;
                return true;
            }
        } finally { Marshal.FreeHGlobal(buf); }
    }

    /// <summary>
    /// Reads USN journal records using FSCTL_READ_USN_JOURNAL (binary, sequence-exact).
    /// Returns events with fileReferenceNumber = "&lt;ref-hex&gt;:&lt;seq-hex&gt;" — NO ':0' placeholder.
    /// </summary>
    public static string ReadUsnJournalInterval(string driveLetter, ulong journalId, long startUsn, long endUsn, int maxEvents) {
        const int BUFFER_SIZE = 256 * 1024;
        if (endUsn < startUsn) return SerializeResult(false, "INVALID_USN_INTERVAL", new System.Collections.Generic.List<object>(), false);
        if (maxEvents <= 0) return SerializeResult(false, "INVALID_MAX_EVENTS", new System.Collections.Generic.List<object>(), false);
        if (Marshal.SizeOf(typeof(READ_USN_JOURNAL_DATA)) != 48)
            return SerializeResult(false, "READ_USN_JOURNAL_DATA_ABI_MISMATCH", new System.Collections.Generic.List<object>(), false);
        IntPtr outBuf = Marshal.AllocHGlobal(BUFFER_SIZE);
        IntPtr dataBuf = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(READ_USN_JOURNAL_DATA)));
        try {
            using (SafeFileHandle vol = OpenVolume(driveLetter)) {
                var rujd = new READ_USN_JOURNAL_DATA {
                    StartUsn = startUsn,
                    ReasonMask = 0xFFFFFFFF,
                    ReturnOnlyOnClose = 0,
                    Timeout = 0,
                    BytesToWaitFor = 0,
                    UsnJournalID = journalId,
                    MinMajorVersion = USN_RECORD_V2_MAJOR_VERSION,
                    MaxMajorVersion = USN_RECORD_V2_MAJOR_VERSION
                };
                Marshal.StructureToPtr(rujd, dataBuf, false);

                var events = new System.Collections.Generic.List<object>();
                bool truncated = false;
                long currentStart = startUsn;
                bool complete = false;

                for (int guard = 0; guard < 128; guard++) {
                    uint bytesReturned;
                    if (!DeviceIoControl(vol, IOCTL_USN_READ_JOURNAL, dataBuf,
                        (uint)Marshal.SizeOf(typeof(READ_USN_JOURNAL_DATA)),
                        outBuf, (uint)BUFFER_SIZE, out bytesReturned, IntPtr.Zero)) {
                        int err = Marshal.GetLastWin32Error();
                        if (err == ERROR_JOURNAL_DELETE_IN_PROGRESS || err == ERROR_JOURNAL_NOT_ACTIVE)
                            return SerializeResult(false, "JOURNAL_RESET", events, truncated);
                        if (err == ERROR_JOURNAL_ENTRY_DELETED)
                            return SerializeResult(false, "GAP_BEFORE_RETAINED", events, truncated);
                        throw new Win32Exception(err, "DeviceIoControl FSCTL_READ_USN_JOURNAL failed (Win32 error " + err.ToString() + ")");
                    }
                    if (bytesReturned < USN_OUTPUT_HEADER_SIZE)
                        return SerializeResult(false, "MALFORMED_USN_OUTPUT_HEADER", events, truncated);

                    long continuationUsn = Marshal.ReadInt64(outBuf);
                    int offset = USN_OUTPUT_HEADER_SIZE;
                    bool sawRecord = false;
                    while (offset < bytesReturned) {
                        int remaining = checked((int)bytesReturned - offset);
                        if (remaining < USN_RECORD_V2_FIXED_SIZE)
                            return SerializeResult(false, "MALFORMED_USN_RECORD_BOUNDS", events, truncated);

                        uint recordLength = unchecked((uint)Marshal.ReadInt32(outBuf + offset));
                        if (recordLength < USN_RECORD_V2_FIXED_SIZE || recordLength > (uint)remaining)
                            return SerializeResult(false, "MALFORMED_USN_RECORD_BOUNDS", events, truncated);

                        ushort majorVersion = unchecked((ushort)Marshal.ReadInt16(outBuf + offset + 4));
                        if (majorVersion != USN_RECORD_V2_MAJOR_VERSION)
                            return SerializeResult(false, "UNSUPPORTED_USN_RECORD_VERSION", events, truncated);

                        sawRecord = true;
                        ulong refVal = unchecked((ulong)Marshal.ReadInt64(outBuf + offset + 8));
                        long usn = Marshal.ReadInt64(outBuf + offset + 24);
                        if (usn > endUsn) { complete = true; break; }
                        if (usn <= startUsn) { offset += checked((int)recordLength); continue; }

                        ulong refLow = refVal & 0x0000FFFFFFFFFFFF;
                        ulong refSeq = refVal >> 48;
                        if (refSeq == 0)
                            return SerializeResult(false, "SEQUENCE_NOT_EXACT", events, truncated);
                        string fileRef = refLow.ToString("x") + ":" + refSeq.ToString("x");

                        string fileName = "";
                        ushort fileNameLength = unchecked((ushort)Marshal.ReadInt16(outBuf + offset + 56));
                        ushort fileNameOffset = unchecked((ushort)Marshal.ReadInt16(outBuf + offset + 58));
                        if (fileNameLength > 0) {
                            if ((fileNameLength & 1) != 0 || fileNameOffset < USN_RECORD_V2_FIXED_SIZE ||
                                fileNameOffset > recordLength || fileNameLength > recordLength - fileNameOffset)
                                return SerializeResult(false, "MALFORMED_USN_RECORD_BOUNDS", events, truncated);
                            fileName = Marshal.PtrToStringUni(outBuf + offset + fileNameOffset, fileNameLength / 2) ?? "";
                        }

                        events.Add(new System.Collections.Generic.Dictionary<string,object> {
                            { "usn", "0x" + usn.ToString("x16") },
                            { "fileReferenceNumber", fileRef },
                            { "fileName", string.IsNullOrEmpty(fileName) ? (object)null : fileName },
                            { "reasonFlags", (long)unchecked((uint)Marshal.ReadInt32(outBuf + offset + 40)) }
                        });
                        if (events.Count >= maxEvents) { truncated = true; return SerializeResult(true, null, events, truncated); }
                        offset += checked((int)recordLength);
                    }

                    if (complete) return SerializeResult(true, null, events, truncated);
                    if (continuationUsn == currentStart && !sawRecord)
                        return SerializeResult(true, null, events, truncated);
                    if (continuationUsn <= currentStart)
                        return SerializeResult(false, "NON_ADVANCING_USN_CONTINUATION", events, truncated);

                    currentStart = continuationUsn;
                    rujd.StartUsn = currentStart;
                    Marshal.StructureToPtr(rujd, dataBuf, false);
                }
                return SerializeResult(false, "USN_CONTINUATION_GUARD_EXCEEDED", events, truncated);
            }
        } finally {
            Marshal.FreeHGlobal(outBuf);
            Marshal.FreeHGlobal(dataBuf);
        }
    }

    private static string SerializeResult(bool ok, string failure, System.Collections.Generic.List<object> events, bool truncated) {
        var sb = new System.Text.StringBuilder();
        sb.Append("{\"ok\":");
        sb.Append(ok ? "true" : "false");
        if (!ok) {
            sb.Append(",\"failure\":\"");
            sb.Append(EscapeJson(failure ?? "HELPER_FAILED"));
            sb.Append("\"}");
        } else {
            sb.Append(",\"truncated\":");
            sb.Append(truncated ? "true" : "false");
            sb.Append(",\"events\":[");
            for (int i = 0; i < events.Count; i++) {
                if (i > 0) sb.Append(",");
                var dict = events[i] as System.Collections.Generic.Dictionary<string, object>;
                if (dict != null) {
                    sb.Append("{");
                    bool first = true;
                    foreach (var kv in dict) {
                        if (!first) sb.Append(",");
                        first = false;
                        sb.Append("\"");
                        sb.Append(kv.Key);
                        sb.Append("\":");
                        if (kv.Value == null) {
                            sb.Append("null");
                        } else if (kv.Value is string) {
                            sb.Append("\"");
                            sb.Append(EscapeJson((string)kv.Value));
                            sb.Append("\"");
                        } else if (kv.Value is bool) {
                            sb.Append(((bool)kv.Value) ? "true" : "false");
                        } else {
                            sb.Append(kv.Value.ToString());
                        }
                    }
                    sb.Append("}");
                } else {
                    sb.Append("{}");
                }
            }
            sb.Append("]}");
        }
        return sb.ToString();
    }

    private static string EscapeJson(string s) {
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }
}
#endif
'@

if ($SelfTest) {
    $base = Join-Path ([IO.Path]::GetTempPath()) ("IntentChord-FsAuthority-" + [Guid]::NewGuid().ToString('N'))
    $root = Join-Path $base 'workspace'
    $outside = Join-Path $base 'outside'
    try {
        [IO.Directory]::CreateDirectory($root) | Out-Null
        [IO.Directory]::CreateDirectory($outside) | Out-Null
        [IO.File]::WriteAllText((Join-Path $root 'authorized-marker.txt'), 'AUTHORIZED')
        [IO.File]::WriteAllText((Join-Path $outside 'outside-marker.txt'), 'OUTSIDE')
        [IO.File]::WriteAllText((Join-Path $root 'same.txt'), 'AUTHORIZED-CHILD')
        [IO.File]::WriteAllText((Join-Path $outside 'same.txt'), 'OUTSIDE-CHILD')
        $probe = [IntentChordFilesystemAuthority]::Probe($root)
        if (-not $probe.ok) { throw "PROBE_FAILED:$($probe.code)" }
        if ($probe.identity.proof_method -ne 'WINDOWS_FILE_ID_128_V1') { throw 'IDENTITY_METHOD_MISMATCH' }
        if ($probe.identity.file_id -notmatch '^[0-9a-f]{32}$') { throw 'FILE_ID_128_FORMAT_INVALID' }
        $swap = [IntentChordFilesystemAuthority]::SelfTestSameHandleDirectorySwap($root, $outside)
        if (-not $swap.ok) { throw "SAME_HANDLE_SWAP_FAILED:$($swap.code):$($swap.message)" }
        $childSwap = [IntentChordFilesystemAuthority]::SelfTestRelativeChildRootSwap($root, $outside)
        if (-not $childSwap.ok) { throw "RELATIVE_CHILD_SWAP_FAILED:$($childSwap.code):$($childSwap.message)" }
        $parentSwap = [IntentChordFilesystemAuthority]::SelfTestRelativeParentSwap($root, $outside)
        if (-not $parentSwap.ok) { throw "RELATIVE_PARENT_SWAP_FAILED:$($parentSwap.code):$($parentSwap.message)" }
        $identitySwap = [IntentChordFilesystemAuthority]::SelfTestRelativeChildIdentitySwap($root)
        if (-not $identitySwap.ok) { throw "RELATIVE_CHILD_IDENTITY_SWAP_FAILED:$($identitySwap.code):$($identitySwap.message)" }
        [Console]::Out.WriteLine((@{
            ok = $true
            code = 'PASS'
            proof_method = $probe.identity.proof_method
            file_id_length = $probe.identity.file_id.Length
            same_handle_swap = 'PASS'
            relative_child_root_swap = 'PASS'
            relative_parent_swap = 'PASS'
            relative_child_identity_swap = 'PASS'
            outside_marker_enumerated = $false
            outside_child_read = $false
        } | ConvertTo-Json -Compress))
        exit 0
    }
    catch {
        [Console]::Error.WriteLine("WINDOWS_FILESYSTEM_AUTHORITY_SELFTEST_ERROR: $($_.Exception.Message)")
        exit 1
    }
    finally { Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction SilentlyContinue }
}

function Invoke-AuthorityRequestLine([string]$line) {
    if ([string]::IsNullOrWhiteSpace($line)) { return }
    try {
        $request = $line | ConvertFrom-Json
        if ($request.op -eq 'probe') {
            $deadlineEpochMs = if ($null -ne $request.deadline_epoch_ms) { [long]$request.deadline_epoch_ms } else { -1L }
            $startupDelayMs = if ($null -ne $request.test_startup_delay_ms) { [int]$request.test_startup_delay_ms } else { 0 }
            if ($deadlineEpochMs -ge 0 -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $deadlineEpochMs) {
                $result = [AuthorityResult]@{ ok = $false; code = 'WORKSPACE_INDEX_TIMEOUT'; message = 'WORKSPACE_INDEX_TIMEOUT'; entries = @() }
            }
            else {
                if ($startupDelayMs -gt 0) { Start-Sleep -Milliseconds $startupDelayMs }
                if ($deadlineEpochMs -ge 0 -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $deadlineEpochMs) {
                    $result = [AuthorityResult]@{ ok = $false; code = 'WORKSPACE_INDEX_TIMEOUT'; message = 'WORKSPACE_INDEX_TIMEOUT'; entries = @() }
                }
                else {
                    $result = [IntentChordFilesystemAuthority]::Probe([string]$request.path)
                }
            }
        }
        elseif ($request.op -eq 'enumerate_relative') {
            $deadlineEpochMs = if ($null -ne $request.deadline_epoch_ms) { [long]$request.deadline_epoch_ms } else { -1L }
            $enumerationChunkDelayMs = if ($null -ne $request.test_enumeration_chunk_delay_ms) { [int]$request.test_enumeration_chunk_delay_ms } else { 0 }
            $emitProgress = if ($null -ne $request.emit_progress) { [bool]$request.emit_progress } else { $false }
            $result = [IntentChordFilesystemAuthority]::EnumerateRelative([string]$request.path,[string]$request.expected_device_id,[string]$request.expected_file_id,[string]$request.relative_path,[string]$request.expected_child_device_id,[string]$request.expected_child_file_id,$deadlineEpochMs,$enumerationChunkDelayMs,$emitProgress)
        }
        elseif ($request.op -eq 'capture_relative') {
            $deadlineEpochMs = if ($null -ne $request.deadline_epoch_ms) { [long]$request.deadline_epoch_ms } else { -1L }
            $maxReadBytes = if ($null -ne $request.max_read_bytes) { [long]$request.max_read_bytes } else { -1L }
            $byteBudgetCode = if ($null -ne $request.byte_budget_code) { [string]$request.byte_budget_code } else { 'WORKSPACE_CAPTURE_BYTE_BUDGET_EXCEEDED' }
            $startupDelayMs = if ($null -ne $request.test_startup_delay_ms) { [int]$request.test_startup_delay_ms } else { 0 }
            $chunkDelayMs = if ($null -ne $request.test_chunk_delay_ms) { [int]$request.test_chunk_delay_ms } else { 0 }
            $responseDelayMs = if ($null -ne $request.test_response_delay_ms) { [int]$request.test_response_delay_ms } else { 0 }
            $emitProgress = if ($null -ne $request.emit_progress) { [bool]$request.emit_progress } else { $false }
            $result = [IntentChordFilesystemAuthority]::CaptureRelative([string]$request.path,[string]$request.expected_device_id,[string]$request.expected_file_id,[string]$request.relative_path,[string]$request.expected_child_device_id,[string]$request.expected_child_file_id,[long]$request.expected_size_bytes,[int]$request.max_prefix_bytes,[bool]$request.count_lines,$deadlineEpochMs,$maxReadBytes,$byteBudgetCode,$startupDelayMs,$chunkDelayMs,$responseDelayMs,$emitProgress)
        }
        else {
            $result = [AuthorityResult]@{ ok = $false; code = 'WORKSPACE_FILESYSTEM_AUTHORITY_PROTOCOL_ERROR'; message = 'Unsupported operation.'; entries = @() }
        }
        [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 8))
        [Console]::Out.Flush()
    }
    catch {
        [Console]::Out.WriteLine((@{ ok = $false; code = 'WORKSPACE_FILESYSTEM_AUTHORITY_PROTOCOL_ERROR'; message = 'Authority helper request failed.'; entries = @() } | ConvertTo-Json -Compress -Depth 8))
        [Console]::Out.Flush()
    }
}

if ($SingleRequest) {
    $single = [Console]::In.ReadLine()
    Invoke-AuthorityRequestLine $single
    exit 0
}

# ==================================================================================
# INTENTCHORD USN CONTINUITY EXTENSION (SPEC V3 Phase 3)
# Appended region ONLY. Existing dispatch/process governance above is untouched.
# Ops are reachable WITHOUT disturbing the legacy dispatch loop via env-gated entry:
#   INTENTCHORD_USN_HELPER_OP = query_usn | read_usn_interval
# Protocol: single-line JSON on stdout, then exit (same framing contract as legacy ops).
# Read-only against USN state. Fails closed on any parse/identity anomaly.
# ==================================================================================

function Invoke-IntentChordUsnQuery {
    param([Parameter(Mandatory)][string]$VolumeRoot)
    return @{ supported = $false; degradationReason = 'USN_AUTHORITY_SERVICE_REQUIRED' } | ConvertTo-Json -Compress
    try {
        $cimDeviceId = Split-Path -Path $VolumeRoot -Qualifier
        $drive = $cimDeviceId + '\'
        $ldFilter = "DeviceID='$cimDeviceId'"
        $ld = Get-CimInstance Win32_LogicalDisk -Filter $ldFilter -ErrorAction Stop | Select-Object -First 1
        $serial = ($ld.VolumeSerialNumber -replace '-', '').ToLowerInvariant()
        $q = & fsutil usn queryjournal $drive 2>&1
        if ($LASTEXITCODE -ne 0) {
            return @{ supported = $false; degradationReason = "USN_QUERYJOURNAL_FAILED:$($q -join ' ')" } | ConvertTo-Json -Compress
        }
        $text = ($q | Out-String)
        $get = { param($label) ([regex]::Match($text, ($label + '\s*:\s*(0x[0-9a-fA-F]+)')).Groups[1].Value) }
        $jid = & $get 'Journal ID'
        $next = & $get 'Next Usn'
        $lowest = & $get 'Lowest Valid Usn'
        $first = & $get 'First Usn'
        if (-not $jid -or -not $next -or -not $first) {
            return @{ supported = $false; degradationReason = 'USN_QUERY_PARSE_FAILED' } | ConvertTo-Json -Compress
        }
        return @{
            supported = $true
            journalId = $jid.ToLowerInvariant()
            volumeSerial = $serial.ToLowerInvariant()
            firstUsn = $first.ToLowerInvariant()
            nextUsn = $next.ToLowerInvariant()
            lowestValidUsn = $(if ($lowest) { $lowest.ToLowerInvariant() } else { $null })
            volumeRoot = $drive
        } | ConvertTo-Json -Compress
    } catch {
        return @{ supported = $false; degradationReason = "USN_QUERY_EXCEPTION:$($_.Exception.Message)" } | ConvertTo-Json -Compress
    }
}

function Invoke-IntentChordUsnReadInterval {
    param(
        [Parameter(Mandatory)][string]$VolumeRoot,
        [Parameter(Mandatory)][string]$ExpectedJournalId,
        [Parameter(Mandatory)][long]$StartExclusive,
        [Parameter(Mandatory)][long]$EndInclusive,
        [int]$MaxEvents = 4096
    )
    return @{ ok = $false; failure = 'PROVIDER_UNAVAILABLE'; detail = 'USN_AUTHORITY_SERVICE_REQUIRED' } | ConvertTo-Json -Compress
    try {
        $capJson = Invoke-IntentChordUsnQuery -VolumeRoot $VolumeRoot
        $cap = $capJson | ConvertFrom-Json
        if (-not $cap.supported) {
            return @{ ok = $false; failure = 'UNSUPPORTED_VOLUME'; detail = $cap.degradationReason } | ConvertTo-Json -Compress
        }
        if ($cap.journalId -ne $ExpectedJournalId.ToLowerInvariant()) {
            return @{ ok = $false; failure = 'JOURNAL_RESET' } | ConvertTo-Json -Compress
        }
        $firstHex = $cap.firstUsn
        $firstVal = [Convert]::ToInt64($firstHex, 16)
        if ($StartExclusive -lt $firstVal) {
            return @{ ok = $false; failure = 'GAP_BEFORE_RETAINED'; firstUsn = $firstHex } | ConvertTo-Json -Compress
        }

        $drive = (Split-Path -Path $VolumeRoot -Qualifier) + '\'
        $journalId = [Convert]::ToUInt64($cap.journalId, 16)

        # STRONG PATH: FSCTL_READ_USN_JOURNAL binary reading (sequence-exact identity)
        # No fsutil. No ':0' placeholder. Binary USN_RECORD_V2 decoding.
        $result = [IntentChordUsnJournalAuthority]::ReadUsnJournalInterval(
            $drive, $journalId, $StartExclusive, $EndInclusive, $MaxEvents)
        return $result
    } catch {
        return @{ ok = $false; failure = 'HELPER_FAILED'; detail = $_.Exception.Message } | ConvertTo-Json -Compress
    }
}

# USN ops are env-gated and bypass the stdin dispatch loop entirely.
# Must be after function definitions (Invoke-IntentChordUsnQuery, Invoke-IntentChordUsnReadInterval).
if ($env:INTENTCHORD_USN_HELPER_OP) {
    if ($env:INTENTCHORD_USN_HELPER_OP -eq 'query_usn') {
        @{ supported = $false; degradationReason = 'USN_AUTHORITY_SERVICE_REQUIRED' } | ConvertTo-Json -Compress
    } else {
        @{ ok = $false; failure = 'PROVIDER_UNAVAILABLE'; detail = 'USN_AUTHORITY_SERVICE_REQUIRED' } | ConvertTo-Json -Compress
    }
    exit 0
}

# Default: persistent stdin dispatch loop (reads JSON requests, writes JSON responses)
try {
    while ($true) {
        $line = [Console]::In.ReadLine()
        if ($null -eq $line) { break }
        Invoke-AuthorityRequestLine $line
    }
} catch {
    [Console]::Out.WriteLine((@{ ok = $false; code = 'WORKSPACE_FILESYSTEM_AUTHORITY_PROTOCOL_ERROR'; message = 'Stdin dispatch loop failed.'; entries = @() } | ConvertTo-Json -Compress -Depth 8))
    [Console]::Out.Flush()
}

