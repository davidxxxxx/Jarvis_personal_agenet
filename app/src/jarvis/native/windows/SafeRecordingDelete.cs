using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Jarvis.Native
{
    public sealed class DeleteResult
    {
        public string Status { get; private set; }
        public string Code { get; private set; }

        public DeleteResult(string status, string code)
        {
            Status = status;
            Code = code;
        }
    }

    public static class SafeRecordingDelete
    {
        private const uint DELETE = 0x00010000;
        private const uint FILE_READ_ATTRIBUTES = 0x00000080;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint FILE_SHARE_DELETE = 0x00000004;
        private const uint OPEN_EXISTING = 3;
        private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
        private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
        private const int ERROR_FILE_NOT_FOUND = 2;
        private const int ERROR_PATH_NOT_FOUND = 3;
        private const int ERROR_INVALID_FUNCTION = 1;
        private const int ERROR_NOT_SUPPORTED = 50;
        private const int ERROR_INVALID_PARAMETER = 87;

        private enum FILE_INFO_BY_HANDLE_CLASS
        {
            FileDispositionInfo = 4,
            FileAttributeTagInfo = 9,
            FileDispositionInfoEx = 21
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct FILE_DISPOSITION_INFO
        {
            [MarshalAs(UnmanagedType.Bool)]
            public bool DeleteFile;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct FILE_DISPOSITION_INFO_EX
        {
            public uint Flags;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct FILE_ATTRIBUTE_TAG_INFO
        {
            public uint FileAttributes;
            public uint ReparseTag;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandleW(
            SafeFileHandle file,
            StringBuilder path,
            uint pathLength,
            uint flags);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetFileInformationByHandle(
            SafeFileHandle file,
            FILE_INFO_BY_HANDLE_CLASS fileInformationClass,
            ref FILE_DISPOSITION_INFO_EX fileInformation,
            uint bufferSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetFileInformationByHandle(
            SafeFileHandle file,
            FILE_INFO_BY_HANDLE_CLASS fileInformationClass,
            ref FILE_DISPOSITION_INFO fileInformation,
            uint bufferSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandleEx(
            SafeFileHandle file,
            FILE_INFO_BY_HANDLE_CLASS fileInformationClass,
            out FILE_ATTRIBUTE_TAG_INFO fileInformation,
            uint bufferSize);

        public static DeleteResult Delete(string root, string target, Action afterValidated)
        {
            string lexicalRoot;
            string lexicalTarget;
            try
            {
                lexicalRoot = Path.GetFullPath(root);
                lexicalTarget = Path.GetFullPath(target);
            }
            catch
            {
                return new DeleteResult("outside", "invalid_path");
            }

            if (!IsWithin(lexicalRoot, lexicalTarget))
                return new DeleteResult("outside", "lexical_outside_root");

            using (SafeFileHandle rootHandle = OpenDirectory(lexicalRoot))
            {
                if (rootHandle.IsInvalid)
                    return new DeleteResult("retry", "root_unavailable");
                string finalRoot = FinalPath(rootHandle);
                if (finalRoot == null)
                    return new DeleteResult("retry", "root_resolution_failed");

                SafeFileHandle targetHandle = CreateFileW(
                    lexicalTarget,
                    DELETE | FILE_READ_ATTRIBUTES,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    IntPtr.Zero,
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                    IntPtr.Zero);

                using (targetHandle)
                {
                    if (targetHandle.IsInvalid)
                    {
                        int openError = Marshal.GetLastWin32Error();
                        if (openError == ERROR_FILE_NOT_FOUND || openError == ERROR_PATH_NOT_FOUND)
                        {
                            DeleteResult ancestorResult = ValidateExistingAncestor(finalRoot, lexicalTarget);
                            return ancestorResult ?? new DeleteResult("missing", "file_not_found");
                        }
                        return new DeleteResult("retry", "open_failed_" + openError);
                    }

                    string finalTarget = FinalPath(targetHandle);
                    if (finalTarget == null)
                        return new DeleteResult("retry", "target_resolution_failed");
                    if (!IsWithin(finalRoot, finalTarget))
                        return new DeleteResult("outside", "handle_outside_root");

                    FILE_ATTRIBUTE_TAG_INFO attributes;
                    if (!GetFileInformationByHandleEx(
                        targetHandle,
                        FILE_INFO_BY_HANDLE_CLASS.FileAttributeTagInfo,
                        out attributes,
                        (uint)Marshal.SizeOf(typeof(FILE_ATTRIBUTE_TAG_INFO))))
                        return new DeleteResult("retry", "attribute_query_failed");
                    if ((attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0)
                        return new DeleteResult("outside", "target_is_directory");

                    if (afterValidated != null) afterValidated();
                    return MarkDelete(targetHandle);
                }
            }
        }

        private static SafeFileHandle OpenDirectory(string directory)
        {
            return CreateFileW(
                directory,
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                IntPtr.Zero,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                IntPtr.Zero);
        }

        private static DeleteResult ValidateExistingAncestor(string finalRoot, string target)
        {
            DirectoryInfo current = Directory.GetParent(target);
            while (current != null)
            {
                using (SafeFileHandle handle = OpenDirectory(current.FullName))
                {
                    if (!handle.IsInvalid)
                    {
                        string finalAncestor = FinalPath(handle);
                        if (finalAncestor == null)
                            return new DeleteResult("retry", "ancestor_resolution_failed");
                        return IsWithinOrEqual(finalRoot, finalAncestor)
                            ? null
                            : new DeleteResult("outside", "ancestor_outside_root");
                    }
                    int error = Marshal.GetLastWin32Error();
                    if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND)
                        return new DeleteResult("retry", "ancestor_open_failed_" + error);
                }
                current = current.Parent;
            }
            return new DeleteResult("retry", "no_existing_ancestor");
        }

        private static DeleteResult MarkDelete(SafeFileHandle handle)
        {
            FILE_DISPOSITION_INFO_EX extended = new FILE_DISPOSITION_INFO_EX { Flags = 0x13 };
            if (SetFileInformationByHandle(
                handle,
                FILE_INFO_BY_HANDLE_CLASS.FileDispositionInfoEx,
                ref extended,
                (uint)Marshal.SizeOf(typeof(FILE_DISPOSITION_INFO_EX))))
                return new DeleteResult("deleted", "deleted");

            int error = Marshal.GetLastWin32Error();
            if (error != ERROR_INVALID_FUNCTION && error != ERROR_NOT_SUPPORTED && error != ERROR_INVALID_PARAMETER)
                return new DeleteResult("retry", "delete_failed_" + error);

            FILE_DISPOSITION_INFO basic = new FILE_DISPOSITION_INFO { DeleteFile = true };
            if (SetFileInformationByHandle(
                handle,
                FILE_INFO_BY_HANDLE_CLASS.FileDispositionInfo,
                ref basic,
                (uint)Marshal.SizeOf(typeof(FILE_DISPOSITION_INFO))))
                return new DeleteResult("deleted", "deleted");
            return new DeleteResult("retry", "delete_failed_" + Marshal.GetLastWin32Error());
        }

        private static string FinalPath(SafeFileHandle handle)
        {
            StringBuilder buffer = new StringBuilder(512);
            uint length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
            if (length == 0) return null;
            if (length >= buffer.Capacity)
            {
                buffer = new StringBuilder((int)length + 1);
                length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
                if (length == 0 || length >= buffer.Capacity) return null;
            }
            string value = buffer.ToString();
            if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase))
                value = @"\\" + value.Substring(8);
            else if (value.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase))
                value = value.Substring(4);
            return Path.GetFullPath(value);
        }

        private static bool IsWithin(string root, string candidate)
        {
            return !string.Equals(Path.GetFullPath(root), Path.GetFullPath(candidate), StringComparison.OrdinalIgnoreCase)
                && IsWithinOrEqual(root, candidate);
        }

        private static bool IsWithinOrEqual(string root, string candidate)
        {
            string normalizedRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string normalizedCandidate = Path.GetFullPath(candidate);
            if (string.Equals(normalizedRoot, normalizedCandidate, StringComparison.OrdinalIgnoreCase)) return true;
            return normalizedCandidate.StartsWith(normalizedRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
        }
    }
}
