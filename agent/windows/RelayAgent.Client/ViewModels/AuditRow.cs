using RelayAgent.Shared;

namespace RelayAgent.Client
{
    public sealed class AuditRow
    {
        public string Time { get; set; }
        public string Kind { get; set; }
        public string Instruction { get; set; }
        public string Status { get; set; }
        public string ExitCode { get; set; }
        public string Duration { get; set; }
        public string JobId { get; set; }
        public CommandAuditSummary Summary { get; set; }
    }
}
