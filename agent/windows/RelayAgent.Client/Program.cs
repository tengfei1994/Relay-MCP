using System;
using System.ServiceProcess;
using System.Windows.Forms;
using RelayAgent.Service;

namespace RelayAgent.Client
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            if (args.Length > 0 && string.Equals(args[0], "--service", StringComparison.OrdinalIgnoreCase))
            {
                ServiceBase.Run(new RelayAgentService());
                return;
            }

            if (args.Length > 0 && string.Equals(args[0], "--console", StringComparison.OrdinalIgnoreCase))
            {
                new RelayAgentService().RunConsole();
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }
}
