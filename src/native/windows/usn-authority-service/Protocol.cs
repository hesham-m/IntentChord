using System.Buffers.Binary;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace IntentChord.UsnAuthorityService;

internal static class Protocol
{
    internal const string Version = "intentchord.usn-authority/v1";
    internal const string CanonicalPipeName = "IntentChordUsnAuthority.v1";
    internal const int MaxMessageBytes = 64 * 1024;
    internal static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };
    internal static async Task<byte[]?> ReadFrameAsync(Stream stream, CancellationToken cancellationToken)
    {
        var header = new byte[4]; if (!await ReadExactlyOrEofAsync(stream, header, cancellationToken)) return null;
        var length = BinaryPrimitives.ReadInt32LittleEndian(header); if (length <= 0 || length > MaxMessageBytes) throw new ProtocolException("INVALID_REQUEST");
        var body = new byte[length]; await stream.ReadExactlyAsync(body, cancellationToken); return body;
    }
    internal static async Task WriteFrameAsync(Stream stream, object value, CancellationToken cancellationToken)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(value, Json); if (body.Length == 0 || body.Length > MaxMessageBytes) throw new ProtocolException("INVALID_REQUEST");
        var header = new byte[4]; BinaryPrimitives.WriteInt32LittleEndian(header, body.Length); await stream.WriteAsync(header, cancellationToken); await stream.WriteAsync(body, cancellationToken); await stream.FlushAsync(cancellationToken);
    }
    private static async Task<bool> ReadExactlyOrEofAsync(Stream stream, byte[] buffer, CancellationToken cancellationToken)
    { var offset = 0; while (offset < buffer.Length) { var read = await stream.ReadAsync(buffer.AsMemory(offset), cancellationToken); if (read == 0) return offset == 0; offset += read; } return true; }
}
internal sealed class ProtocolException(string code) : Exception(code) { internal string Code { get; } = code; }
internal sealed class AuthorityConfig
{
    public string PipeName { get; init; } = Protocol.CanonicalPipeName;
    public IReadOnlyList<string> AllowedClientSids { get; init; } = Array.Empty<string>();
    public int RequestTimeoutMs { get; init; } = 30_000;
    internal static AuthorityConfig Load(string? configPath, string? pipeName, string? allowedClientSid)
    {
        AuthorityConfig configured = new(); if (!string.IsNullOrWhiteSpace(configPath)) configured = JsonSerializer.Deserialize<AuthorityConfig>(File.ReadAllText(configPath), Protocol.Json) ?? throw new InvalidOperationException("INVALID_SERVICE_CONFIG");
        var sids = !string.IsNullOrWhiteSpace(allowedClientSid) ? allowedClientSid.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries) : configured.AllowedClientSids;
        if (sids.Count == 0 || sids.Any(s => !s.StartsWith("S-1-", StringComparison.OrdinalIgnoreCase))) throw new InvalidOperationException("ALLOWED_CLIENT_SID_REQUIRED");
        return new AuthorityConfig { PipeName = string.IsNullOrWhiteSpace(pipeName) ? configured.PipeName : pipeName, AllowedClientSids = sids.Select(s => s.ToUpperInvariant()).Distinct(StringComparer.OrdinalIgnoreCase).ToArray(), RequestTimeoutMs = Math.Clamp(configured.RequestTimeoutMs, 1_000, 120_000) };
    }
}
internal sealed class AuthorityRequest { public string? Protocol { get; init; } public string? RequestId { get; init; } public string? Op { get; init; } public string? VolumeRoot { get; init; } public string? JournalId { get; init; } public string? StartUsnExclusive { get; init; } public string? EndUsnInclusive { get; init; } public int? MaxEvents { get; init; } }
internal sealed class AuthorityResponse
{
    public string Protocol { get; init; } = global::IntentChord.UsnAuthorityService.Protocol.Version; public string? RequestId { get; init; } public bool? Supported { get; init; } public string? VolumeRoot { get; init; } public string? VolumeSerial { get; init; } public string? JournalId { get; init; } public string? FirstUsn { get; init; } public string? NextUsn { get; init; } public string? LowestValidUsn { get; init; } public string? DegradationReason { get; init; } public bool? Ok { get; init; } public string? Failure { get; init; } public string? Detail { get; init; } public IReadOnlyList<UsnEventResponse>? Events { get; init; } public bool? Truncated { get; init; }
}
internal sealed class UsnEventResponse { public string Usn { get; init; } = ""; public string FileReferenceNumber { get; init; } = ""; public string? FileName { get; init; } public uint ReasonFlags { get; init; } }
internal sealed class PipeAuthorityServer(AuthorityConfig config)
{
    private readonly AuthorityConfig _config = config;
    // Keep a bounded set of authenticated pipe instances listening so concurrent
    // USN evidence requests never see a missing pipe solely because one is busy.
    // An unexpected worker failure cancels the server; no insecure fallback.
    private const int ListenerCount = 8;
    internal async Task RunAsync(CancellationToken stoppingToken, bool once)
    {
        if (once)
        {
            using var single = CreatePipe();
            await single.WaitForConnectionAsync(stoppingToken);
            await HandleOneAsync(single, stoppingToken);
            return;
        }
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
        var workers = Enumerable.Range(0, ListenerCount).Select(_ => ServeLoopAsync(lifetime)).ToArray();
        await Task.WhenAll(workers);
    }
    private async Task ServeLoopAsync(CancellationTokenSource lifetime)
    {
        try
        {
            while (!lifetime.IsCancellationRequested)
            {
                using var pipe = CreatePipe();
                await pipe.WaitForConnectionAsync(lifetime.Token);
                await HandleOneAsync(pipe, lifetime.Token);
            }
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch
        {
            lifetime.Cancel();
            throw;
        }
    }
    private NamedPipeServerStream CreatePipe()
    {
        var security = new PipeSecurity(); security.SetAccessRuleProtection(true, false);
        foreach (var sid in _config.AllowedClientSids) security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(sid), PipeAccessRights.ReadWrite | PipeAccessRights.Synchronize, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        return NamedPipeServerStreamAcl.Create(_config.PipeName, PipeDirection.InOut, ListenerCount, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.WriteThrough, Protocol.MaxMessageBytes, Protocol.MaxMessageBytes, security, HandleInheritability.None, PipeAccessRights.ChangePermissions);
    }
    private async Task HandleOneAsync(NamedPipeServerStream pipe, CancellationToken stoppingToken)
    {
        using var requestTimeout = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken); requestTimeout.CancelAfter(_config.RequestTimeoutMs); var cancellationToken = requestTimeout.Token; AuthorityRequest? request = null;
        try
        {
            var body = await Protocol.ReadFrameAsync(pipe, cancellationToken); if (body is null) return;
            ValidateAuthenticatedPipeClient(pipe);
            request = JsonSerializer.Deserialize<AuthorityRequest>(body, Protocol.Json) ?? throw new ProtocolException("INVALID_REQUEST"); await Protocol.WriteFrameAsync(pipe, Dispatch(request), cancellationToken);
        }
        catch (OperationCanceledException) when (!stoppingToken.IsCancellationRequested) { await TryWriteAsync(pipe, new AuthorityResponse { RequestId = request?.RequestId, Failure = "TIMEOUT" }, CancellationToken.None); }
        catch (ProtocolException ex) { await TryWriteAsync(pipe, new AuthorityResponse { RequestId = request?.RequestId, Failure = ex.Code }, CancellationToken.None); }
        catch (Exception ex) { Console.Error.WriteLine($"USN_AUTHORITY_REQUEST_FAILED:{ex.GetType().Name}:{ex.Message}"); await TryWriteAsync(pipe, new AuthorityResponse { RequestId = request?.RequestId, Failure = "NATIVE_FAILURE" }, CancellationToken.None); }
    }
    private static async Task TryWriteAsync(Stream stream, object value, CancellationToken cancellationToken) { try { await Protocol.WriteFrameAsync(stream, value, cancellationToken); } catch { } }
    // The DACL is the authoritative SID comparison. This second server-side check
    // rejects anonymous/unidentified pipe clients before protocol dispatch.
    private static void ValidateAuthenticatedPipeClient(NamedPipeServerStream pipe) { if (string.IsNullOrWhiteSpace(pipe.GetImpersonationUserName())) throw new ProtocolException("ACCESS_DENIED"); }
    private static AuthorityResponse Dispatch(AuthorityRequest request)
    {
        if (request.Protocol != Protocol.Version || string.IsNullOrWhiteSpace(request.RequestId) || request.RequestId.Length > 128) throw new ProtocolException("PROTOCOL_MISMATCH");
        if (request.Op == "QUERY_USN") { if (!NativeUsnAuthority.TryNormalizeVolumeRoot(request.VolumeRoot, out var root)) throw new ProtocolException("INVALID_REQUEST"); var query = NativeUsnAuthority.Query(root); return query.Supported ? new AuthorityResponse { RequestId = request.RequestId, Supported = true, VolumeRoot = root, VolumeSerial = query.VolumeSerial, JournalId = query.JournalId, FirstUsn = query.FirstUsn, NextUsn = query.NextUsn, LowestValidUsn = query.LowestValidUsn } : new AuthorityResponse { RequestId = request.RequestId, Supported = false, VolumeRoot = root, DegradationReason = query.Failure }; }
        if (request.Op == "READ_USN_INTERVAL") { if (!NativeUsnAuthority.TryNormalizeVolumeRoot(request.VolumeRoot, out var root) || !NativeUsnAuthority.TryParseUsn(request.JournalId, out var journalId) || !NativeUsnAuthority.TryParseUsn(request.StartUsnExclusive, out var start) || !NativeUsnAuthority.TryParseUsn(request.EndUsnInclusive, out var end) || start > end) throw new ProtocolException("INVALID_REQUEST"); return NativeUsnAuthority.Read(root, journalId, start, end, Math.Clamp(request.MaxEvents ?? 4096, 1, 4096), request.RequestId!); }
        throw new ProtocolException("INVALID_REQUEST");
    }
}
