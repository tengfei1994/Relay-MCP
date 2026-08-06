using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;

namespace RelayAgent.Client.Controls
{
    public sealed class TerminalTextBox : TextBox
    {
        private const double MinimumFontSize = 10;
        private const double MaximumFontSize = 20;
        private string _lastSearchText = "";

        public TerminalTextBox()
        {
            FontFamily = new FontFamily("Consolas");
            FontSize = 12;
            Background = new SolidColorBrush(Color.FromRgb(15, 23, 42));
            Foreground = new SolidColorBrush(Color.FromRgb(226, 232, 240));
            BorderBrush = new SolidColorBrush(Color.FromRgb(51, 65, 85));
            CaretBrush = Foreground;
            Padding = new Thickness(12, 10, 12, 10);
            IsReadOnly = true;
            AcceptsReturn = true;
            AcceptsTab = true;
            TextWrapping = TextWrapping.NoWrap;
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
            HorizontalScrollBarVisibility = ScrollBarVisibility.Auto;
            MinHeight = 160;
            ContextMenu = BuildContextMenu();
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if ((Keyboard.Modifiers & ModifierKeys.Control) == ModifierKeys.Control)
            {
                if (e.Key == Key.F)
                {
                    ShowFindDialog();
                    e.Handled = true;
                    return;
                }
                if (e.Key == Key.Add || e.Key == Key.OemPlus)
                {
                    FontSize = Math.Min(MaximumFontSize, FontSize + 1);
                    e.Handled = true;
                    return;
                }
                if (e.Key == Key.Subtract || e.Key == Key.OemMinus)
                {
                    FontSize = Math.Max(MinimumFontSize, FontSize - 1);
                    e.Handled = true;
                    return;
                }
                if (e.Key == Key.D0 || e.Key == Key.NumPad0)
                {
                    FontSize = 12;
                    e.Handled = true;
                    return;
                }
            }

            if (e.Key == Key.F3)
            {
                FindNext();
                e.Handled = true;
                return;
            }

            base.OnKeyDown(e);
        }

        protected override void OnPreviewMouseWheel(MouseWheelEventArgs e)
        {
            if ((Keyboard.Modifiers & ModifierKeys.Control) == ModifierKeys.Control)
            {
                FontSize = Math.Max(
                    MinimumFontSize,
                    Math.Min(MaximumFontSize, FontSize + (e.Delta > 0 ? 1 : -1)));
                e.Handled = true;
                return;
            }

            base.OnPreviewMouseWheel(e);
        }

        private ContextMenu BuildContextMenu()
        {
            var menu = new ContextMenu();
            menu.Items.Add(CreateMenuItem("Copy selected", delegate
            {
                if (!string.IsNullOrEmpty(SelectedText))
                {
                    Clipboard.SetText(SelectedText);
                }
            }));
            menu.Items.Add(CreateMenuItem("Copy all", delegate
            {
                if (!string.IsNullOrEmpty(Text))
                {
                    Clipboard.SetText(Text);
                }
            }));
            menu.Items.Add(new Separator());
            menu.Items.Add(CreateMenuItem("Find...", delegate { ShowFindDialog(); }));
            menu.Items.Add(CreateMenuItem("Find next", delegate { FindNext(); }));
            menu.Items.Add(new Separator());
            menu.Items.Add(CreateMenuItem("Toggle line wrap", delegate
            {
                TextWrapping = TextWrapping == TextWrapping.NoWrap
                    ? TextWrapping.Wrap
                    : TextWrapping.NoWrap;
                HorizontalScrollBarVisibility = TextWrapping == TextWrapping.NoWrap
                    ? ScrollBarVisibility.Auto
                    : ScrollBarVisibility.Disabled;
            }));
            menu.Items.Add(CreateMenuItem("Zoom in", delegate { FontSize = Math.Min(MaximumFontSize, FontSize + 1); }));
            menu.Items.Add(CreateMenuItem("Zoom out", delegate { FontSize = Math.Max(MinimumFontSize, FontSize - 1); }));
            menu.Items.Add(CreateMenuItem("Reset zoom", delegate { FontSize = 12; }));
            return menu;
        }

        private void ShowFindDialog()
        {
            var owner = Window.GetWindow(this);
            var dialog = new Window
            {
                Title = "Find in output",
                Owner = owner,
                WindowStartupLocation = owner == null
                    ? WindowStartupLocation.CenterScreen
                    : WindowStartupLocation.CenterOwner,
                ResizeMode = ResizeMode.NoResize,
                SizeToContent = SizeToContent.WidthAndHeight,
                Background = Brushes.White,
                FontFamily = new FontFamily("Segoe UI"),
                FontSize = 13
            };

            var panel = new Grid
            {
                Margin = new Thickness(18),
                MinWidth = 360
            };
            panel.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            panel.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

            var input = new TextBox
            {
                Text = _lastSearchText,
                MinHeight = 34,
                Padding = new Thickness(8, 5, 8, 5)
            };
            panel.Children.Add(input);

            var buttons = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                HorizontalAlignment = HorizontalAlignment.Right,
                Margin = new Thickness(0, 14, 0, 0)
            };
            Grid.SetRow(buttons, 1);

            var findButton = new Button
            {
                Content = "Find next",
                MinWidth = 92,
                MinHeight = 34,
                Margin = new Thickness(0, 0, 8, 0),
                IsDefault = true
            };
            var cancelButton = new Button
            {
                Content = "Cancel",
                MinWidth = 82,
                MinHeight = 34,
                IsCancel = true
            };
            findButton.Click += delegate
            {
                _lastSearchText = input.Text ?? "";
                dialog.DialogResult = true;
                dialog.Close();
                FindNext();
            };
            buttons.Children.Add(findButton);
            buttons.Children.Add(cancelButton);
            panel.Children.Add(buttons);

            dialog.Content = panel;
            dialog.Loaded += delegate
            {
                input.Focus();
                input.SelectAll();
            };
            dialog.ShowDialog();
        }

        private void FindNext()
        {
            if (string.IsNullOrEmpty(_lastSearchText) || string.IsNullOrEmpty(Text))
            {
                ShowFindDialog();
                return;
            }

            var start = SelectionStart + Math.Max(SelectionLength, 0);
            var index = Text.IndexOf(_lastSearchText, start, StringComparison.OrdinalIgnoreCase);
            if (index < 0 && start > 0)
            {
                index = Text.IndexOf(_lastSearchText, 0, StringComparison.OrdinalIgnoreCase);
            }
            if (index < 0)
            {
                System.Media.SystemSounds.Beep.Play();
                return;
            }

            Focus();
            Select(index, _lastSearchText.Length);
            ScrollToLine(GetLineIndexFromCharacterIndex(index));
        }

        private static MenuItem CreateMenuItem(string header, RoutedEventHandler handler)
        {
            var item = new MenuItem { Header = header };
            item.Click += handler;
            return item;
        }
    }
}
