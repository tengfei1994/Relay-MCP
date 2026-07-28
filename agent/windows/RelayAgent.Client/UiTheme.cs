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
                Height = 36,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                MinimumSize = new Size(104, 36),
                Margin = new Padding(0, 0, 10, 0),
                Padding = new Padding(14, 0, 14, 0),
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
                BackColor = Color.Transparent
            };
        }

        public static TextBox StyleTextBox(TextBox textBox)
        {
            textBox.Font = BodyFont;
            textBox.BorderStyle = BorderStyle.FixedSingle;
            textBox.BackColor = Surface;
            textBox.ForeColor = Text;
            textBox.Margin = new Padding(0, 3, 0, 8);
            return textBox;
        }

        public static ComboBox StyleComboBox(ComboBox comboBox)
        {
            comboBox.Font = BodyFont;
            comboBox.DropDownStyle = ComboBoxStyle.DropDownList;
            comboBox.FlatStyle = FlatStyle.Flat;
            comboBox.BackColor = Surface;
            comboBox.ForeColor = Text;
            comboBox.Margin = new Padding(0, 3, 0, 8);
            return comboBox;
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
            grid.ColumnHeadersBorderStyle = DataGridViewHeaderBorderStyle.None;
            grid.ColumnHeadersHeight = 38;
            grid.RowTemplate.Height = 34;
            grid.EnableHeadersVisualStyles = false;
            grid.ColumnHeadersDefaultCellStyle.BackColor = Color.FromArgb(247, 248, 250);
            grid.ColumnHeadersDefaultCellStyle.ForeColor = MutedText;
            grid.ColumnHeadersDefaultCellStyle.Font = new Font("Segoe UI Semibold", 8.5f);
            grid.DefaultCellStyle.BackColor = Surface;
            grid.DefaultCellStyle.ForeColor = Text;
            grid.DefaultCellStyle.Font = SmallFont;
            grid.DefaultCellStyle.SelectionBackColor = PrimarySoft;
            grid.DefaultCellStyle.SelectionForeColor = Text;
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
                var glyphSize = e.Graphics.MeasureString(Glyph, UiTheme.GlyphFont);
                var textSize = e.Graphics.MeasureString(Text, Font);
                var totalWidth = glyphSize.Width + 7 + textSize.Width;
                var startX = (Width - totalWidth) / 2f;
                using (var brush = new SolidBrush(colors.Item3))
                {
                    e.Graphics.DrawString(
                        Glyph,
                        UiTheme.GlyphFont,
                        brush,
                        startX,
                        (Height - glyphSize.Height) / 2f);
                    e.Graphics.DrawString(
                        Text,
                        Font,
                        brush,
                        startX + glyphSize.Width + 7,
                        (Height - textSize.Height) / 2f);
                }
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
                TextFormatFlags.NoPrefix);
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
                new Rectangle(46, 0, Width - 54, Height),
                Selected ? UiTheme.Primary : UiTheme.Text,
                TextFormatFlags.VerticalCenter |
                TextFormatFlags.EndEllipsis |
                TextFormatFlags.NoPrefix);
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
