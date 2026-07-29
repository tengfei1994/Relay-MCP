using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace RelayAgent.Client
{
    internal static class UiTheme
    {
        public static readonly Color AppBackground = Color.FromArgb(248, 248, 250);
        public static readonly Color Surface = Color.White;
        public static readonly Color Sidebar = Color.FromArgb(251, 251, 252);
        public static readonly Color Border = Color.FromArgb(226, 228, 232);
        public static readonly Color Text = Color.FromArgb(28, 31, 36);
        public static readonly Color MutedText = Color.FromArgb(103, 109, 118);
        public static readonly Color Primary = Color.FromArgb(47, 111, 224);
        public static readonly Color PrimarySoft = Color.FromArgb(232, 240, 254);
        public static readonly Color Success = Color.FromArgb(31, 139, 76);
        public static readonly Color SuccessSoft = Color.FromArgb(232, 247, 238);
        public static readonly Color Warning = Color.FromArgb(190, 112, 18);
        public static readonly Color WarningSoft = Color.FromArgb(255, 247, 230);
        public static readonly Color Danger = Color.FromArgb(198, 55, 55);
        public static readonly Color DangerSoft = Color.FromArgb(253, 237, 237);

        public static readonly Font BodyFont = new Font("Segoe UI", 9.5f, FontStyle.Regular);
        public static readonly Font SmallFont = new Font("Segoe UI", 8.5f, FontStyle.Regular);
        public static readonly Font SectionFont = new Font("Segoe UI Semibold", 11f, FontStyle.Bold);
        public static readonly Font TitleFont = new Font("Segoe UI Semibold", 19f, FontStyle.Bold);
        public static readonly Font GlyphFont = new Font("Segoe MDL2 Assets", 11f, FontStyle.Regular);

        public static Icon CreateAppIcon()
        {
            using (var bitmap = new Bitmap(32, 32))
            using (var graphics = Graphics.FromImage(bitmap))
            using (var background = new SolidBrush(Primary))
            using (var textBrush = new SolidBrush(Color.White))
            using (var font = new Font("Segoe UI Semibold", 17f, FontStyle.Bold, GraphicsUnit.Pixel))
            {
                graphics.SmoothingMode = SmoothingMode.AntiAlias;
                graphics.FillRectangle(background, 0, 0, 32, 32);
                TextRenderer.DrawText(
                    graphics,
                    "R",
                    font,
                    new Rectangle(0, 0, 32, 32),
                    Color.White,
                    TextFormatFlags.HorizontalCenter |
                    TextFormatFlags.VerticalCenter |
                    TextFormatFlags.NoPadding);
                var handle = bitmap.GetHicon();
                try
                {
                    using (var icon = Icon.FromHandle(handle))
                    {
                        return (Icon)icon.Clone();
                    }
                }
                finally
                {
                    DestroyIcon(handle);
                }
            }
        }

        [DllImport("user32.dll")]
        private static extern bool DestroyIcon(IntPtr handle);

        public static Button CreateButton(
            string text,
            EventHandler handler,
            ButtonTone tone = ButtonTone.Secondary,
            string glyph = "")
        {
            var button = new ModernButton
            {
                Text = text,
                Glyph = glyph,
                Tone = tone,
                Height = 40,
                AutoSize = false,
                Width = CalculateButtonWidth(text, glyph),
                MinimumSize = new Size(108, 40),
                Margin = new Padding(0, 0, 10, 0),
                Padding = new Padding(12, 2, 12, 2),
                Cursor = Cursors.Hand
            };
            if (handler != null)
            {
                button.Click += handler;
            }
            return button;
        }

        public static Label CreateLabel(
            string text,
            Color? color = null,
            Font font = null,
            ContentAlignment alignment = ContentAlignment.MiddleLeft)
        {
            return new Label
            {
                Text = text,
                ForeColor = color ?? Text,
                Font = font ?? BodyFont,
                TextAlign = alignment,
                AutoSize = false,
                Dock = DockStyle.Fill,
                Padding = new Padding(0, 2, 0, 2),
                UseMnemonic = false,
                BackColor = Color.Transparent
            };
        }

        private static int CalculateButtonWidth(string text, string glyph)
        {
            var textSize = TextRenderer.MeasureText(
                text ?? "",
                BodyFont,
                new Size(int.MaxValue, int.MaxValue),
                TextFormatFlags.NoPadding);
            var glyphSize = string.IsNullOrWhiteSpace(glyph)
                ? 0
                : TextRenderer.MeasureText(
                    glyph,
                    GlyphFont,
                    new Size(int.MaxValue, int.MaxValue),
                    TextFormatFlags.NoPadding).Width + 7;
            return Math.Max(108, textSize.Width + glyphSize + 34);
        }

        public static TextBox StyleTextBox(TextBox textBox)
        {
            textBox.Font = BodyFont;
            textBox.BorderStyle = BorderStyle.FixedSingle;
            textBox.BackColor = Surface;
            textBox.ForeColor = Text;
            textBox.MinimumSize = new Size(0, 32);
            textBox.Padding = new Padding(6, 2, 6, 2);
            textBox.Margin = new Padding(0, 2, 0, 2);
            return textBox;
        }

        public static ComboBox StyleComboBox(ComboBox comboBox)
        {
            comboBox.Font = BodyFont;
            comboBox.DropDownStyle = ComboBoxStyle.DropDownList;
            comboBox.FlatStyle = FlatStyle.Flat;
            comboBox.BackColor = Surface;
            comboBox.ForeColor = Text;
            comboBox.MinimumSize = new Size(0, 32);
            comboBox.ItemHeight = 24;
            comboBox.Margin = new Padding(0, 2, 0, 2);
            return comboBox;
        }

        public static NumericUpDown StyleNumericUpDown(NumericUpDown numericUpDown)
        {
            numericUpDown.Font = BodyFont;
            numericUpDown.BackColor = Surface;
            numericUpDown.ForeColor = Text;
            numericUpDown.BorderStyle = BorderStyle.FixedSingle;
            numericUpDown.MinimumSize = new Size(0, 32);
            numericUpDown.Padding = new Padding(6, 2, 6, 2);
            numericUpDown.Margin = new Padding(0, 2, 0, 2);
            return numericUpDown;
        }

        public static void StyleGrid(DataGridView grid)
        {
            grid.BackgroundColor = Surface;
            grid.BorderStyle = BorderStyle.None;
            grid.CellBorderStyle = DataGridViewCellBorderStyle.SingleHorizontal;
            grid.GridColor = Border;
            grid.RowHeadersVisible = false;
            grid.AllowUserToAddRows = false;
            grid.AllowUserToDeleteRows = false;
            grid.AllowUserToResizeRows = false;
            grid.MultiSelect = false;
            grid.SelectionMode = DataGridViewSelectionMode.FullRowSelect;
            grid.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill;
            grid.AutoSizeRowsMode = DataGridViewAutoSizeRowsMode.None;
            grid.ColumnHeadersBorderStyle = DataGridViewHeaderBorderStyle.None;
            grid.ColumnHeadersHeight = 42;
            grid.RowTemplate.Height = 38;
            grid.EnableHeadersVisualStyles = false;
            grid.ColumnHeadersDefaultCellStyle.BackColor = Color.FromArgb(247, 248, 250);
            grid.ColumnHeadersDefaultCellStyle.ForeColor = MutedText;
            grid.ColumnHeadersDefaultCellStyle.Font = new Font("Segoe UI Semibold", 8.5f);
            grid.ColumnHeadersDefaultCellStyle.Padding = new Padding(8, 3, 8, 3);
            grid.DefaultCellStyle.BackColor = Surface;
            grid.DefaultCellStyle.ForeColor = Text;
            grid.DefaultCellStyle.Font = SmallFont;
            grid.DefaultCellStyle.Padding = new Padding(8, 3, 8, 3);
            grid.DefaultCellStyle.SelectionBackColor = PrimarySoft;
            grid.DefaultCellStyle.SelectionForeColor = Text;
            grid.CellToolTipTextNeeded += (sender, args) =>
            {
                if (args.RowIndex < 0 || args.ColumnIndex < 0)
                {
                    return;
                }

                var value = grid.Rows[args.RowIndex].Cells[args.ColumnIndex].Value;
                args.ToolTipText = value == null ? "" : Convert.ToString(value);
            };
        }
    }

    internal enum ButtonTone
    {
        Primary,
        Secondary,
        Danger,
        Ghost
    }

    internal sealed class ModernButton : Button
    {
        public string Glyph { get; set; }
        public ButtonTone Tone { get; set; }

        public ModernButton()
        {
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 1;
            Font = UiTheme.BodyFont;
            TextAlign = ContentAlignment.MiddleCenter;
            UseVisualStyleBackColor = false;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var colors = ResolveColors();
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var path = RoundedRectangle(ClientRectangle, 7))
            using (var background = new SolidBrush(colors.Item1))
            using (var border = new Pen(colors.Item2))
            {
                e.Graphics.FillPath(background, path);
                e.Graphics.DrawPath(border, path);
            }

            var textRectangle = ClientRectangle;
            if (!string.IsNullOrWhiteSpace(Glyph))
            {
                var glyphSize = TextRenderer.MeasureText(
                    e.Graphics,
                    Glyph,
                    UiTheme.GlyphFont,
                    new Size(int.MaxValue, int.MaxValue),
                    TextFormatFlags.NoPadding);
                var textSize = TextRenderer.MeasureText(
                    e.Graphics,
                    Text,
                    Font,
                    new Size(int.MaxValue, int.MaxValue),
                    TextFormatFlags.NoPadding);
                var totalWidth = glyphSize.Width + 7 + textSize.Width;
                var availableWidth = Math.Max(0, Width - Padding.Left - Padding.Right);
                var startX = Padding.Left + Math.Max(0, (availableWidth - totalWidth) / 2);
                var glyphRectangle = new Rectangle(
                    startX,
                    Padding.Top,
                    Math.Max(1, glyphSize.Width),
                    Math.Max(1, Height - Padding.Vertical));
                var textRectangleWithEllipsis = new Rectangle(
                    startX + glyphSize.Width + 7,
                    Padding.Top,
                    Math.Max(1, Width - startX - glyphSize.Width - 7 - Padding.Right),
                    Math.Max(1, Height - Padding.Vertical));
                TextRenderer.DrawText(
                    e.Graphics,
                    Glyph,
                    UiTheme.GlyphFont,
                    glyphRectangle,
                    colors.Item3,
                    TextFormatFlags.HorizontalCenter |
                    TextFormatFlags.VerticalCenter |
                    TextFormatFlags.NoPadding);
                TextRenderer.DrawText(
                    e.Graphics,
                    Text,
                    Font,
                    textRectangleWithEllipsis,
                    colors.Item3,
                    TextFormatFlags.VerticalCenter |
                    TextFormatFlags.EndEllipsis |
                    TextFormatFlags.NoPrefix |
                    TextFormatFlags.NoPadding);
                return;
            }

            TextRenderer.DrawText(
                e.Graphics,
                Text,
                Font,
                textRectangle,
                colors.Item3,
                TextFormatFlags.HorizontalCenter |
                TextFormatFlags.VerticalCenter |
                TextFormatFlags.EndEllipsis |
                TextFormatFlags.NoPrefix |
                TextFormatFlags.NoPadding);
        }

        protected override void OnMouseEnter(EventArgs e)
        {
            base.OnMouseEnter(e);
            Invalidate();
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            Invalidate();
        }

        private Tuple<Color, Color, Color> ResolveColors()
        {
            if (!Enabled)
            {
                return Tuple.Create(
                    Color.FromArgb(242, 243, 245),
                    UiTheme.Border,
                    Color.FromArgb(151, 155, 162));
            }

            var hover = ClientRectangle.Contains(PointToClient(Cursor.Position));
            if (Tone == ButtonTone.Primary)
            {
                return Tuple.Create(
                    hover ? Color.FromArgb(36, 94, 201) : UiTheme.Primary,
                    hover ? Color.FromArgb(36, 94, 201) : UiTheme.Primary,
                    Color.White);
            }
            if (Tone == ButtonTone.Danger)
            {
                return Tuple.Create(
                    hover ? UiTheme.DangerSoft : UiTheme.Surface,
                    UiTheme.Danger,
                    UiTheme.Danger);
            }
            if (Tone == ButtonTone.Ghost)
            {
                return Tuple.Create(
                    hover ? Color.FromArgb(242, 244, 247) : Color.Transparent,
                    Color.Transparent,
                    UiTheme.MutedText);
            }

            return Tuple.Create(
                hover ? Color.FromArgb(246, 247, 249) : UiTheme.Surface,
                UiTheme.Border,
                UiTheme.Text);
        }

        private static GraphicsPath RoundedRectangle(Rectangle bounds, int radius)
        {
            var path = new GraphicsPath();
            var diameter = radius * 2;
            var rectangle = new Rectangle(
                bounds.X,
                bounds.Y,
                Math.Max(1, bounds.Width - 1),
                Math.Max(1, bounds.Height - 1));
            path.AddArc(rectangle.X, rectangle.Y, diameter, diameter, 180, 90);
            path.AddArc(rectangle.Right - diameter, rectangle.Y, diameter, diameter, 270, 90);
            path.AddArc(rectangle.Right - diameter, rectangle.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(rectangle.X, rectangle.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }
    }

    internal sealed class SectionPanel : Panel
    {
        public SectionPanel()
        {
            BackColor = UiTheme.Surface;
            Padding = new Padding(18);
            Margin = new Padding(0, 0, 14, 14);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            var rectangle = new Rectangle(0, 0, Math.Max(1, Width - 1), Math.Max(1, Height - 1));
            using (var path = new GraphicsPath())
            using (var pen = new Pen(UiTheme.Border))
            {
                var radius = 8;
                var diameter = radius * 2;
                path.AddArc(rectangle.X, rectangle.Y, diameter, diameter, 180, 90);
                path.AddArc(rectangle.Right - diameter, rectangle.Y, diameter, diameter, 270, 90);
                path.AddArc(rectangle.Right - diameter, rectangle.Bottom - diameter, diameter, diameter, 0, 90);
                path.AddArc(rectangle.X, rectangle.Bottom - diameter, diameter, diameter, 90, 90);
                path.CloseFigure();
                e.Graphics.DrawPath(pen, path);
            }
        }
    }

    internal sealed class StepBadge : Control
    {
        public StepBadge()
        {
            Size = new Size(32, 32);
            MinimumSize = new Size(32, 32);
            MaximumSize = new Size(32, 32);
            Font = new Font("Segoe UI Semibold", 9.5f, FontStyle.Bold);
            ForeColor = UiTheme.Primary;
            SetStyle(
                ControlStyles.AllPaintingInWmPaint |
                ControlStyles.OptimizedDoubleBuffer |
                ControlStyles.ResizeRedraw |
                ControlStyles.SupportsTransparentBackColor |
                ControlStyles.UserPaint,
                true);
            BackColor = Color.Transparent;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            var bounds = new Rectangle(0, 0, Math.Max(1, Width - 1), Math.Max(1, Height - 1));
            using (var background = new SolidBrush(UiTheme.PrimarySoft))
            using (var border = new Pen(Color.FromArgb(210, 225, 250)))
            {
                e.Graphics.FillEllipse(background, bounds);
                e.Graphics.DrawEllipse(border, bounds);
            }

            TextRenderer.DrawText(
                e.Graphics,
                Text,
                Font,
                ClientRectangle,
                UiTheme.Primary,
                TextFormatFlags.HorizontalCenter |
                TextFormatFlags.VerticalCenter |
                TextFormatFlags.NoPadding |
                TextFormatFlags.NoPrefix);
        }
    }

    internal sealed class NavButton : Button
    {
        private bool _selected;

        public string Glyph { get; set; }

        public bool Selected
        {
            get { return _selected; }
            set
            {
                _selected = value;
                Invalidate();
            }
        }

        public NavButton()
        {
            Height = 42;
            Dock = DockStyle.None;
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
            TextAlign = ContentAlignment.MiddleLeft;
            Padding = new Padding(46, 0, 10, 0);
            Font = UiTheme.BodyFont;
            Cursor = Cursors.Hand;
            UseVisualStyleBackColor = false;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var hover = ClientRectangle.Contains(PointToClient(Cursor.Position));
            var background = Selected
                ? UiTheme.PrimarySoft
                : hover ? Color.FromArgb(244, 245, 247) : UiTheme.Sidebar;
            e.Graphics.Clear(background);

            if (Selected)
            {
                using (var brush = new SolidBrush(UiTheme.Primary))
                {
                    e.Graphics.FillRectangle(brush, 0, 7, 3, Height - 14);
                }
            }

            using (var glyphBrush = new SolidBrush(Selected ? UiTheme.Primary : UiTheme.MutedText))
            {
                e.Graphics.DrawString(
                    Glyph ?? "",
                    UiTheme.GlyphFont,
                    glyphBrush,
                    17,
                    (Height - UiTheme.GlyphFont.Height) / 2f);
            }

            TextRenderer.DrawText(
                e.Graphics,
                Text,
                Font,
                new Rectangle(46, 1, Math.Max(1, Width - 54), Math.Max(1, Height - 2)),
                Selected ? UiTheme.Primary : UiTheme.Text,
                TextFormatFlags.VerticalCenter |
                TextFormatFlags.EndEllipsis |
                TextFormatFlags.NoPrefix |
                TextFormatFlags.NoPadding);
        }

        protected override void OnMouseEnter(EventArgs e)
        {
            base.OnMouseEnter(e);
            Invalidate();
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            Invalidate();
        }
    }
}
