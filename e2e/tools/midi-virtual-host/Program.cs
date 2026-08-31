using System.Text.Json;
using Windows.Devices.Midi2;
using Windows.Devices.Midi2.Enumeration;
using Windows.Devices.Midi2.Transports.Virtual;
using Windows.Devices.Midi2.Utilities.Messages;

const string EndpointName = "OSG Isolated MIDI Controller";

static MidiVirtualDeviceCreationConfig DefineDevice()
{
    var endpoint = new MidiDeclaredEndpointInfo
    {
        Name = EndpointName,
        ProductInstanceId = "OSG_E2E_MIDI_1",
        SpecificationVersionMajor = 1,
        SpecificationVersionMinor = 1,
        SupportsMidi10Protocol = true,
        SupportsMidi20Protocol = true,
        SupportsReceivingJitterReductionTimestamps = false,
        SupportsSendingJitterReductionTimestamps = false,
        HasStaticFunctionBlocks = true,
    };
    var identity = new MidiDeclaredDeviceIdentity();
    identity.SetDeviceFamily(0x01, 0x01);
    identity.SetDeviceFamilyModelNumber(0x01, 0x01);
    identity.SetSoftwareRevisionLevel(0x01, 0x00, 0x00, 0x00);
    identity.SetSystemExclusiveId(0x00, 0x00, 0x7D);
    var supplied = new MidiEndpointUserSuppliedInfo
    {
        Name = EndpointName,
        Description = "Disposable controller for the guarded OSG real-binary journey",
    };
    var config = new MidiVirtualDeviceCreationConfig(
        EndpointName,
        "Process-owned test controller",
        "OSG",
        endpoint,
        identity,
        supplied)
    {
        CreateOnlyUmpEndpoints = false,
    };
    config.FunctionBlocks.Add(new MidiFunctionBlock
    {
        Number = 0,
        Name = "Controls",
        IsActive = true,
        UIHint = MidiFunctionBlockUIHint.Sender,
        FirstGroup = new MidiGroup(0),
        GroupCount = 1,
        Direction = MidiFunctionBlockDirection.BlockOutput,
        RepresentsMidi10Connection = MidiFunctionBlockRepresentsMidi10Connection.YesBandwidthUnrestricted,
        MaxSystemExclusive8Streams = 0,
        MidiCIMessageVersionFormat = 0,
    });
    return config;
}

static void WriteRecord(object record)
{
    Console.Out.WriteLine(JsonSerializer.Serialize(record));
    Console.Out.Flush();
}

if (!MidiApi.EnsureServiceAvailable() || !MidiVirtualDeviceManager.IsTransportAvailable)
{
    WriteRecord(new { ready = false, reason = "midi-service-unavailable" });
    return 2;
}

var creation = DefineDevice();
using var session = MidiSession.Create("OSG isolated MIDI journey");
if (session is null)
{
    WriteRecord(new { ready = false, reason = "session-unavailable" });
    return 3;
}
var device = MidiVirtualDeviceManager.CreateVirtualDevice(creation);
if (device is null)
{
    WriteRecord(new { ready = false, reason = "virtual-device-unavailable" });
    return 4;
}
device.SuppressHandledMessages = true;
var connection = session.CreateEndpointConnection(device.DeviceEndpointDeviceId);
if (connection is null)
{
    WriteRecord(new { ready = false, reason = "connection-unavailable" });
    return 5;
}
connection.AddMessageProcessingPlugin(device);
if (!connection.Open())
{
    WriteRecord(new { ready = false, reason = "connection-refused" });
    return 6;
}

WriteRecord(new { ready = true, name = EndpointName });
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

// The preview SDK can block while explicitly disconnecting a virtual endpoint. The endpoint is
// process-owned by contract, so terminating this dedicated helper is the deterministic teardown.
Environment.Exit(0);
return 0;
