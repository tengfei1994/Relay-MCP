using System.Windows.Media;

namespace RelayAgent.Client
{
    public sealed class PermissionRow
    {
        public string Permission { get; set; }
        public string Current { get; set; }
        public string Read { get; set; }
        public string Write { get; set; }
        public string Ddl { get; set; }
        public Brush StatusForeground { get; set; }
        public Brush StatusBackground { get; set; }
    }
}
