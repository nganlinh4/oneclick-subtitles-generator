using System.Text.Json;
using Windows.Devices.Enumeration;
using Windows.Devices.Midi2;
using Windows.Devices.Midi2.Diagnostics;
using Windows.Devices.Midi2.Utilities.Messages;

static void WriteRecord(object record)
{
    Console.Out.WriteLine(JsonSerializer.Serialize(record));
    Console.Out.Flush();
}

static void WriteStage(string stage)
{
    Console.Error.WriteLine($"midi-host-stage:{stage}");
    Console.Error.Flush();
}

WriteStage("service-check-start");
if (!MidiApi.EnsureServiceAvailable())
{
    WriteRecord(new { ready = false, reason = "midi-service-unavailable" });
    return 2;
}

WriteStage("service-check-complete");
var sendEndpointId = MidiDiagnostics.DiagnosticsLoopbackAEndpointDeviceId;
var receiveEndpointId = MidiDiagnostics.DiagnosticsLoopbackBEndpointDeviceId;
var receiveEndpoint = await DeviceInformation.CreateFromIdAsync(receiveEndpointId);
if (receiveEndpoint is null)
{
    WriteRecord(new { ready = false, reason = "diagnostics-endpoint-unavailable" });
    return 3;
}

WriteStage("session-create-start");
using var session = MidiSession.Create("OSG isolated MIDI journey");
if (session is null)
{
    WriteRecord(new { ready = false, reason = "session-unavailable" });
    return 4;
}

WriteStage("session-create-complete");
var connection = session.CreateEndpointConnection(sendEndpointId);
if (connection is null)
{
    WriteRecord(new { ready = false, reason = "connection-unavailable" });
    return 5;
}

WriteStage("connection-open-start");
if (!connection.Open())
{
    WriteRecord(new { ready = false, reason = "connection-refused" });
    return 6;
}

WriteStage("connection-open-complete");
WriteRecord(new
{
    ready = true,
    name = receiveEndpoint.Name,
    endpointId = receiveEndpointId,
});

string? line;
while ((line = Console.In.ReadLine()) is not null)
{
    var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    if (parts.Length == 1 && parts[0] == "quit")
    {
        break;
    }
    if (parts.Length != 4
        || parts[0] != "cc"
        || !byte.TryParse(parts[1], out var channel)
        || !byte.TryParse(parts[2], out var controller)
        || !byte.TryParse(parts[3], out var value)
        || channel > 15
        || controller > 127
        || value > 127)
    {
        WriteRecord(new { sent = false, reason = "invalid-command" });
        continue;
    }
    var message = MidiMessageBuilder.BuildMidi1ChannelVoiceMessage(
        MidiClock.Now,
        new MidiGroup(0),
        Midi1ChannelVoiceMessageStatus.ControlChange,
        new MidiChannel(channel),
        controller,
        value);
    var result = connection.SendSingleMessagePacket(message);
    WriteRecord(new
    {
        sent = MidiEndpointConnection.SendMessageSucceeded(result),
        channel,
        controller,
        value,
    });
}

session.DisconnectEndpointConnection(connection.ConnectionId);
return 0;
