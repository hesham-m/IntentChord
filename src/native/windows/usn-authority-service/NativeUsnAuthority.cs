using Microsoft.Win32.SafeHandles;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace IntentChord.UsnAuthorityService;

// The sole production FSCTL implementation. The normal app has no volume handle.
internal static class NativeUsnAuthority
{
    private const uint IOCTL_USN_QUERY_JOURNAL = 0x000900F4, IOCTL_USN_READ_JOURNAL = 0x000900BB, GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000, FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, OPEN_EXISTING = 3;
    private const int ERROR_JOURNAL_DELETE_IN_PROGRESS = 1178, ERROR_JOURNAL_NOT_ACTIVE = 1179, ERROR_JOURNAL_ENTRY_DELETED = 1181, OutputHeaderBytes = 8, RecordV2Bytes = 60, BufferBytes = 256 * 1024;
    [StructLayout(LayoutKind.Sequential)] private struct USN_JOURNAL_DATA { public ulong UsnJournalID, FirstUsn, NextUsn, LowestValidUsn, MaxUsn, MaximumSize, AllocationDelta; }
    [StructLayout(LayoutKind.Sequential, Pack = 8)] private struct READ_USN_JOURNAL_DATA { public long StartUsn; public uint ReasonMask, ReturnOnlyOnClose; public ulong Timeout, BytesToWaitFor, UsnJournalID; public ushort MinMajorVersion, MaxMajorVersion; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string n, uint access, uint share, IntPtr sa, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool DeviceIoControl(SafeFileHandle h, uint ctl, IntPtr input, uint inputLen, IntPtr output, uint outputLen, out uint returned, IntPtr overlapped);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetVolumeInformationW(string root, IntPtr name, uint nameLen, out uint serial, out uint maxComponent, out uint flags, IntPtr fs, uint fsLen);
    internal sealed record QueryResult(bool Supported, string Failure, string? VolumeSerial = null, string? JournalId = null, string? FirstUsn = null, string? NextUsn = null, string? LowestValidUsn = null);
    internal static bool TryNormalizeVolumeRoot(string? value, out string root) { root = ""; if (value is null || value.Length is < 2 or > 3 || !char.IsLetter(value[0]) || value[1] != ':' || (value.Length == 3 && value[2] != '\\')) return false; root = char.ToUpperInvariant(value[0]) + @":\"; return true; }
    internal static bool TryParseUsn(string? value, out ulong parsed) { parsed = 0; return value is not null && value.StartsWith("0x", StringComparison.Ordinal) && value.Length > 2 && ulong.TryParse(value[2..], System.Globalization.NumberStyles.AllowHexSpecifier, null, out parsed) && parsed <= long.MaxValue; }
    internal static QueryResult Query(string root)
    {
        IntPtr buffer = IntPtr.Zero; try { buffer = Marshal.AllocHGlobal(Marshal.SizeOf<USN_JOURNAL_DATA>()); using var volume = OpenVolume(root); if (!DeviceIoControl(volume, IOCTL_USN_QUERY_JOURNAL, IntPtr.Zero, 0, buffer, (uint)Marshal.SizeOf<USN_JOURNAL_DATA>(), out _, IntPtr.Zero)) return new(false, MapLastError(Marshal.GetLastWin32Error())); if (!GetVolumeInformationW(root, IntPtr.Zero, 0, out var serial, out _, out _, IntPtr.Zero, 0)) return new(false, "NATIVE_FAILURE"); var data = Marshal.PtrToStructure<USN_JOURNAL_DATA>(buffer); return new(true, "", serial.ToString("x8"), Hex(data.UsnJournalID), Hex(data.FirstUsn), Hex(data.NextUsn), Hex(data.LowestValidUsn)); }
        catch (Win32Exception ex) { return new(false, MapLastError(ex.NativeErrorCode)); } catch { return new(false, "NATIVE_FAILURE"); } finally { if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer); }
    }
    internal static AuthorityResponse Read(string root, ulong journalId, ulong start, ulong end, int maxEvents, string requestId)
    {
        var query = Query(root); if (!query.Supported) return new AuthorityResponse { RequestId = requestId, Ok = false, Failure = query.Failure == "JOURNAL_RESET" ? "JOURNAL_RESET" : "NATIVE_FAILURE" }; if (!string.Equals(query.JournalId, Hex(journalId), StringComparison.OrdinalIgnoreCase)) return new AuthorityResponse { RequestId = requestId, Ok = false, Failure = "JOURNAL_RESET" }; if (TryParseUsn(query.FirstUsn, out var first) && start < first) return new AuthorityResponse { RequestId = requestId, Ok = false, Failure = "GAP_BEFORE_RETAINED" }; if (Marshal.SizeOf<READ_USN_JOURNAL_DATA>() != 48) return new AuthorityResponse { RequestId = requestId, Ok = false, Failure = "NATIVE_FAILURE" };
        IntPtr outBuffer = IntPtr.Zero, inputBuffer = IntPtr.Zero;
        try
        {
            outBuffer = Marshal.AllocHGlobal(BufferBytes); inputBuffer = Marshal.AllocHGlobal(Marshal.SizeOf<READ_USN_JOURNAL_DATA>()); using var volume = OpenVolume(root); var input = new READ_USN_JOURNAL_DATA { StartUsn = (long)start, ReasonMask = 0xFFFFFFFF, UsnJournalID = journalId, MinMajorVersion = 2, MaxMajorVersion = 2 }; var events = new List<UsnEventResponse>(); var current = (long)start;
            for (var guard = 0; guard < 128; guard++)
            {
                input.StartUsn = current; Marshal.StructureToPtr(input, inputBuffer, false); if (!DeviceIoControl(volume, IOCTL_USN_READ_JOURNAL, inputBuffer, (uint)Marshal.SizeOf<READ_USN_JOURNAL_DATA>(), outBuffer, BufferBytes, out var bytes, IntPtr.Zero)) return new AuthorityResponse { RequestId = requestId, Ok = false, Failure = MapReadError(Marshal.GetLastWin32Error()) }; if (bytes < OutputHeaderBytes) return new AuthorityResponse { RequestId = requestId, Ok = false, Failure = "NATIVE_FAILURE" };
                var continuation = Marshal.ReadInt64(outBuffer); var offset = OutputHeaderBytes; var sawRecord = false;
                while (offset < bytes)
                {
                    var remaining = checked((int)bytes - offset); if (remaining < RecordV2Bytes) return new AuthorityResponse { RequestId = requestId, Ok = false, Failure = "NATIVE_FAILURE" }; var length = unchecked((uint)Marshal.ReadInt32(outBuffer + offset)); if (length < RecordV2Bytes || length > remaining || Marshal.ReadInt16(outBuffer + offset + 4) != 2) return new AuthorityResponse { RequestId = requestId, Ok = false, Failure = "NATIVE_FAILURE" }; sawRecord = true; var usn = Marshal.ReadInt64(outBuffer + offset + 24); if (usn > (long)end) return new AuthorityResponse { RequestId = requestId, Ok = true, Events = events, Truncated = false }; if (usn <= (long)start) { offset += (int)length; continue; }
                    var reference = unchecked((ulong)Marshal.ReadInt64(outBuffer + offset + 8)); var sequence = reference >> 48; if (sequence == 0) return new AuthorityResponse { RequestId = requestId, Ok = false, Failure = "NATIVE_FAILURE" }; var nameLength = unchecked((ushort)Marshal.ReadInt16(outBuffer + offset + 56)); var nameOffset = unchecked((ushort)Marshal.ReadInt16(outBuffer + offset + 58)); if ((nameLength & 1) != 0 || (nameLength > 0 && (nameOffset < RecordV2Bytes || nameOffset > length || nameLength > length - nameOffset))) return new AuthorityResponse { RequestId = requestId, Ok = false, Failure = "NATIVE_FAILURE" };
                    events.Add(new UsnEventResponse { Usn = Hex((ulong)usn), FileReferenceNumber = (reference & 0x0000FFFFFFFFFFFF).ToString("x") + ":" + sequence.ToString("x"), FileName = nameLength == 0 ? null : Marshal.PtrToStringUni(outBuffer + offset + nameOffset, nameLength / 2), ReasonFlags = unchecked((uint)Marshal.ReadInt32(outBuffer + offset + 40)) }); if (events.Count >= maxEvents) return new AuthorityResponse { RequestId = requestId, Ok = true, Events = events, Truncated = true }; offset += (int)length;
                }
                if (continuation == current && !sawRecord) return new AuthorityResponse { RequestId = requestId, Ok = true, Events = events, Truncated = false }; if (continuation <= current) return new AuthorityResponse { RequestId = requestId, Ok = false, Failure = "NATIVE_FAILURE" }; current = continuation;
            }
            return new AuthorityResponse { RequestId = requestId, Ok = false, Failure = "NATIVE_FAILURE" };
        }
        catch { return new AuthorityResponse { RequestId = requestId, Ok = false, Failure = "NATIVE_FAILURE" }; } finally { if (outBuffer != IntPtr.Zero) Marshal.FreeHGlobal(outBuffer); if (inputBuffer != IntPtr.Zero) Marshal.FreeHGlobal(inputBuffer); }
    }
    private static SafeFileHandle OpenVolume(string root) { var handle = CreateFileW(@"\\.\" + root.TrimEnd('\\'), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero); if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error()); return handle; }
    private static string Hex(ulong value) => "0x" + value.ToString("x"); private static string MapLastError(int error) => error is ERROR_JOURNAL_DELETE_IN_PROGRESS or ERROR_JOURNAL_NOT_ACTIVE ? "JOURNAL_RESET" : "NATIVE_FAILURE"; private static string MapReadError(int error) => error is ERROR_JOURNAL_DELETE_IN_PROGRESS or ERROR_JOURNAL_NOT_ACTIVE ? "JOURNAL_RESET" : error == ERROR_JOURNAL_ENTRY_DELETED ? "GAP_BEFORE_RETAINED" : "NATIVE_FAILURE";
}
