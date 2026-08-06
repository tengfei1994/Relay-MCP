using RelayAgent.Shared;

namespace RelayAgent.Client
{
    public sealed class AuditRow
    {
        public string Time { get; set; }
        public string Method { get; set; }
        public string Endpoint { get; set; }
        public string Status { get; set; }
        public string Duration { get; set; }
        public string JobId { get; set; }
        public string Payload { get; set; }
        public HttpAuditEntry Entry { get; set; }
    }
}
