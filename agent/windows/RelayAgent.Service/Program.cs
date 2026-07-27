using System;
using System.ServiceProcess;

namespace RelayAgent.Service
{
    internal static class Program
    {
        private static void Main(string[] args)
        {
            if (args.Length > 0 && args[0].Equals("--console", StringComparison.OrdinalIgnoreCase))
            {
                var service = new RelayAgentService();
                service.RunConsole();
                return;
            }

            ServiceBase.Run(new RelayAgentService());
        }
    }
}

