use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSourceInfo {
    pub id: String,
    pub kind: &'static str,
    pub title: String,
    pub width: i32,
    pub height: i32,
}

#[cfg(target_os = "windows")]
mod win {
    use super::CaptureSourceInfo;
    use std::cell::RefCell;
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, RECT, TRUE};
    use windows_sys::Win32::Graphics::Gdi::{
        BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, COLORONCOLOR, CreateCompatibleBitmap,
        CreateCompatibleDC, CreateDIBSection, DIB_RGB_COLORS, DeleteDC, DeleteObject,
        EnumDisplayMonitors, GdiFlush, GetDC, GetMonitorInfoW, HBITMAP, HDC, HGDIOBJ, HMONITOR,
        MONITORINFOEXW, ReleaseDC, SRCCOPY, SelectObject, SetStretchBltMode, StretchBlt,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClientRect, GetDesktopWindow, GetWindowRect, GetWindowTextLengthW,
        GetWindowTextW, IsIconic, IsWindowVisible,
    };

    #[link(name = "user32")]
    unsafe extern "system" {
        fn PrintWindow(hwnd: HWND, hdcblt: HDC, nflags: u32) -> BOOL;
    }

    #[derive(Clone)]
    struct MonitorRect {
        name: String,
        rect: RECT,
    }

    unsafe extern "system" fn enum_monitor_cb(
        hmon: HMONITOR,
        _hdc: HDC,
        _rect: *mut RECT,
        lparam: LPARAM,
    ) -> BOOL {
        let vec = unsafe { &mut *(lparam as *mut Vec<MonitorRect>) };
        let mut info: MONITORINFOEXW = unsafe { std::mem::zeroed() };
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if unsafe { GetMonitorInfoW(hmon, &mut info as *mut _ as *mut _) } != 0 {
            let end = info
                .szDevice
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(info.szDevice.len());
            let name = String::from_utf16_lossy(&info.szDevice[..end]);
            vec.push(MonitorRect {
                name,
                rect: info.monitorInfo.rcMonitor,
            });
        }
        TRUE
    }

    unsafe extern "system" fn enum_window_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let vec = unsafe { &mut *(lparam as *mut Vec<(usize, String, i32, i32)>) };
        if unsafe { IsWindowVisible(hwnd) } == 0 || unsafe { IsIconic(hwnd) } != 0 {
            return TRUE;
        }
        let len = unsafe { GetWindowTextLengthW(hwnd) };
        if len <= 0 {
            return TRUE;
        }
        let mut buf = vec![0u16; (len as usize) + 1];
        let copied = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        if copied <= 0 {
            return TRUE;
        }
        let title = String::from_utf16_lossy(&buf[..copied as usize])
            .trim()
            .to_string();
        if title.is_empty() || title == "Program Manager" {
            return TRUE;
        }
        let mut rect: RECT = unsafe { std::mem::zeroed() };
        if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
            return TRUE;
        }
        let w = rect.right - rect.left;
        let h = rect.bottom - rect.top;
        if w < 120 || h < 80 {
            return TRUE;
        }
        vec.push((hwnd as usize, title, w, h));
        TRUE
    }

    pub fn list_sources() -> Vec<CaptureSourceInfo> {
        let mut out = Vec::new();
        let mut monitors: Vec<MonitorRect> = Vec::new();
        unsafe {
            EnumDisplayMonitors(
                std::ptr::null_mut(),
                std::ptr::null(),
                Some(enum_monitor_cb),
                &mut monitors as *mut _ as LPARAM,
            );
        }
        for (idx, m) in monitors.into_iter().enumerate() {
            let w = (m.rect.right - m.rect.left).max(1);
            let h = (m.rect.bottom - m.rect.top).max(1);
            out.push(CaptureSourceInfo {
                id: format!("mon:{idx}"),
                kind: "monitor",
                title: format!("Display {} ({}×{} · {})", idx + 1, w, h, m.name),
                width: w,
                height: h,
            });
        }

        let mut windows: Vec<(usize, String, i32, i32)> = Vec::new();
        unsafe {
            EnumWindows(Some(enum_window_cb), &mut windows as *mut _ as LPARAM);
        }
        for (hwnd_val, title, w, h) in windows.into_iter().take(24) {
            out.push(CaptureSourceInfo {
                id: format!("win:{hwnd_val}"),
                kind: "window",
                title,
                width: w,
                height: h,
            });
        }
        out
    }

    pub struct CaptureSession {
        dst_dc: HDC,
        dst_bmp: HBITMAP,
        old_dst: HGDIOBJ,
        dst_bits: *mut u8,
        dst_w: i32,
        dst_h: i32,
        full_dc: HDC,
        full_bmp: HBITMAP,
        old_full: HGDIOBJ,
        full_w: i32,
        full_h: i32,
        rgba_packet: Vec<u8>,
    }

    impl CaptureSession {
        pub fn new() -> Self {
            Self {
                dst_dc: std::ptr::null_mut(),
                dst_bmp: std::ptr::null_mut(),
                old_dst: std::ptr::null_mut(),
                dst_bits: std::ptr::null_mut(),
                dst_w: 0,
                dst_h: 0,
                full_dc: std::ptr::null_mut(),
                full_bmp: std::ptr::null_mut(),
                old_full: std::ptr::null_mut(),
                full_w: 0,
                full_h: 0,
                rgba_packet: Vec::new(),
            }
        }

        unsafe fn ensure_dst_surface(&mut self, ref_dc: HDC, w: i32, h: i32) -> Result<(), String> {
            if !self.dst_dc.is_null() && self.dst_w == w && self.dst_h == h {
                return Ok(());
            }
            unsafe { self.release_dst_surface() };

            let mem_dc = unsafe { CreateCompatibleDC(ref_dc) };
            if mem_dc.is_null() {
                return Err("CreateCompatibleDC failed".into());
            }
            let mut bmi: BITMAPINFO = unsafe { std::mem::zeroed() };
            bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            bmi.bmiHeader.biWidth = w;
            bmi.bmiHeader.biHeight = -h; // top-down DIB so scanlines match canvas row order
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = 32;
            bmi.bmiHeader.biCompression = BI_RGB;

            let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
            let dib_bmp = unsafe {
                CreateDIBSection(
                    mem_dc,
                    &bmi,
                    DIB_RGB_COLORS,
                    &mut bits,
                    std::ptr::null_mut(),
                    0,
                )
            };
            if dib_bmp.is_null() || bits.is_null() {
                if !dib_bmp.is_null() {
                    unsafe { DeleteObject(dib_bmp as _) };
                }
                unsafe { DeleteDC(mem_dc) };
                return Err("CreateDIBSection failed".into());
            }
            let old = unsafe { SelectObject(mem_dc, dib_bmp as _) };
            unsafe { SetStretchBltMode(mem_dc, COLORONCOLOR) };

            self.dst_dc = mem_dc;
            self.dst_bmp = dib_bmp;
            self.old_dst = old;
            self.dst_bits = bits as *mut u8;
            self.dst_w = w;
            self.dst_h = h;
            Ok(())
        }

        unsafe fn ensure_full_surface(
            &mut self,
            ref_dc: HDC,
            w: i32,
            h: i32,
        ) -> Result<(), String> {
            if !self.full_dc.is_null() && self.full_w == w && self.full_h == h {
                return Ok(());
            }
            unsafe { self.release_full_surface() };
            let full_dc = unsafe { CreateCompatibleDC(ref_dc) };
            if full_dc.is_null() {
                return Err("CreateCompatibleDC(full) failed".into());
            }
            let full_bmp = unsafe { CreateCompatibleBitmap(ref_dc, w, h) };
            if full_bmp.is_null() {
                unsafe { DeleteDC(full_dc) };
                return Err("CreateCompatibleBitmap(full) failed".into());
            }
            let old = unsafe { SelectObject(full_dc, full_bmp as _) };
            self.full_dc = full_dc;
            self.full_bmp = full_bmp;
            self.old_full = old;
            self.full_w = w;
            self.full_h = h;
            Ok(())
        }

        unsafe fn release_dst_surface(&mut self) {
            if !self.dst_dc.is_null() {
                if !self.old_dst.is_null() {
                    unsafe { SelectObject(self.dst_dc, self.old_dst) };
                    self.old_dst = std::ptr::null_mut();
                }
                if !self.dst_bmp.is_null() {
                    unsafe { DeleteObject(self.dst_bmp as _) };
                    self.dst_bmp = std::ptr::null_mut();
                }
                unsafe { DeleteDC(self.dst_dc) };
                self.dst_dc = std::ptr::null_mut();
            }
            self.dst_bits = std::ptr::null_mut();
            self.dst_w = 0;
            self.dst_h = 0;
        }

        unsafe fn release_full_surface(&mut self) {
            if !self.full_dc.is_null() {
                if !self.old_full.is_null() {
                    unsafe { SelectObject(self.full_dc, self.old_full) };
                    self.old_full = std::ptr::null_mut();
                }
                if !self.full_bmp.is_null() {
                    unsafe { DeleteObject(self.full_bmp as _) };
                    self.full_bmp = std::ptr::null_mut();
                }
                unsafe { DeleteDC(self.full_dc) };
                self.full_dc = std::ptr::null_mut();
            }
            self.full_w = 0;
            self.full_h = 0;
        }

        #[allow(clippy::too_many_arguments)]
        unsafe fn capture_region_into_dib(
            &mut self,
            src_dc: HDC,
            src_x: i32,
            src_y: i32,
            src_w: i32,
            src_h: i32,
            dst_w: i32,
            dst_h: i32,
            print_hwnd: Option<HWND>,
        ) -> Result<(i32, i32), String> {
            unsafe { self.ensure_dst_surface(src_dc, dst_w, dst_h)? };

            if let Some(hwnd) = print_hwnd {
                if src_w == dst_w && src_h == dst_h {
                    // Zero intermediate buffer: PrintWindow directly into top-down DIB
                    let printed = unsafe { PrintWindow(hwnd, self.dst_dc, 2) };
                    if printed == 0 {
                        let ok = unsafe {
                            BitBlt(self.dst_dc, 0, 0, dst_w, dst_h, src_dc, 0, 0, SRCCOPY)
                        };
                        if ok == 0 {
                            return Err("Window BitBlt fallback failed capturing surface".into());
                        }
                    }
                } else {
                    unsafe { self.ensure_full_surface(src_dc, src_w, src_h)? };
                    let printed = unsafe { PrintWindow(hwnd, self.full_dc, 2) };
                    if printed == 0 {
                        let _ = unsafe {
                            BitBlt(self.full_dc, 0, 0, src_w, src_h, src_dc, 0, 0, SRCCOPY)
                        };
                    }
                    let ok = unsafe {
                        StretchBlt(
                            self.dst_dc,
                            0,
                            0,
                            dst_w,
                            dst_h,
                            self.full_dc,
                            0,
                            0,
                            src_w,
                            src_h,
                            SRCCOPY,
                        )
                    };
                    if ok == 0 {
                        return Err("StretchBlt failed capturing scaled window".into());
                    }
                }
            } else {
                let ok = if src_w == dst_w && src_h == dst_h {
                    unsafe {
                        BitBlt(
                            self.dst_dc,
                            0,
                            0,
                            dst_w,
                            dst_h,
                            src_dc,
                            src_x,
                            src_y,
                            SRCCOPY,
                        )
                    }
                } else {
                    unsafe {
                        StretchBlt(
                            self.dst_dc,
                            0,
                            0,
                            dst_w,
                            dst_h,
                            src_dc,
                            src_x,
                            src_y,
                            src_w,
                            src_h,
                            SRCCOPY,
                        )
                    }
                };
                if ok == 0 {
                    return Err(
                        "StretchBlt failed capturing screen region (desktop locked or protected?)"
                            .into(),
                    );
                }
            }

            unsafe { GdiFlush() };
            Ok((dst_w, dst_h))
        }

        fn capture_source_dib(
            &mut self,
            source_id: &str,
            max_width: i32,
        ) -> Result<(i32, i32), String> {
            let max_width = max_width.clamp(320, 3840);
            if let Some(mon_idx_str) = source_id.strip_prefix("mon:") {
                let idx: usize = mon_idx_str.parse().map_err(|_| "Invalid monitor index")?;
                let mut monitors: Vec<MonitorRect> = Vec::new();
                unsafe {
                    EnumDisplayMonitors(
                        std::ptr::null_mut(),
                        std::ptr::null(),
                        Some(enum_monitor_cb),
                        &mut monitors as *mut _ as LPARAM,
                    );
                }
                let mon = monitors
                    .get(idx)
                    .ok_or_else(|| format!("Monitor {idx} not found"))?;
                let src_w = (mon.rect.right - mon.rect.left).max(1);
                let src_h = (mon.rect.bottom - mon.rect.top).max(1);
                let (dst_w, dst_h) = scale_dims(src_w, src_h, max_width);
                unsafe {
                    let mut src_dc = GetDC(std::ptr::null_mut());
                    let mut release_hwnd: HWND = std::ptr::null_mut();
                    if src_dc.is_null() {
                        release_hwnd = GetDesktopWindow();
                        src_dc = GetDC(release_hwnd);
                    }
                    if src_dc.is_null() {
                        return Err("GetDC(screen) failed".into());
                    }
                    let res = self.capture_region_into_dib(
                        src_dc,
                        mon.rect.left,
                        mon.rect.top,
                        src_w,
                        src_h,
                        dst_w,
                        dst_h,
                        None,
                    );
                    ReleaseDC(release_hwnd, src_dc);
                    return res;
                }
            }

            if let Some(win_id_str) = source_id.strip_prefix("win:") {
                let raw_hwnd: usize = win_id_str.parse().map_err(|_| "Invalid window handle")?;
                let hwnd = raw_hwnd as HWND;
                if unsafe { IsWindowVisible(hwnd) } == 0 {
                    return Err("Selected window is no longer visible".into());
                }
                let mut rect: RECT = unsafe { std::mem::zeroed() };
                unsafe { GetClientRect(hwnd, &mut rect) };
                let src_w = (rect.right - rect.left).max(1);
                let src_h = (rect.bottom - rect.top).max(1);
                let (dst_w, dst_h) = scale_dims(src_w, src_h, max_width);
                unsafe {
                    let src_dc = GetDC(hwnd);
                    if src_dc.is_null() {
                        return Err("GetDC(window) failed".into());
                    }
                    let res = self.capture_region_into_dib(
                        src_dc,
                        0,
                        0,
                        src_w,
                        src_h,
                        dst_w,
                        dst_h,
                        Some(hwnd),
                    );
                    ReleaseDC(hwnd, src_dc);
                    return res;
                }
            }

            Err(format!("Unsupported capture source id: {source_id}"))
        }

        /// Captures directly into an 8-byte header + RGBA8 frame slice `[w: u32_le][h: u32_le][RGBA...]`.
        pub fn capture_rgba_packet(
            &mut self,
            source_id: &str,
            max_width: i32,
        ) -> Result<&[u8], String> {
            let (dst_w, dst_h) = self.capture_source_dib(source_id, max_width)?;
            let pixel_count = (dst_w as usize) * (dst_h as usize);
            let total_len = 8 + pixel_count * 4;
            if self.rgba_packet.len() != total_len {
                self.rgba_packet.resize(total_len, 0);
            }
            self.rgba_packet[0..4].copy_from_slice(&(dst_w as u32).to_le_bytes());
            self.rgba_packet[4..8].copy_from_slice(&(dst_h as u32).to_le_bytes());

            let bgra_words =
                unsafe { std::slice::from_raw_parts(self.dst_bits as *const u32, pixel_count) };
            let (out_chunks, _) = self.rgba_packet[8..].as_chunks_mut::<4>();
            for (&bgra, out) in bgra_words.iter().zip(out_chunks) {
                out[0] = (bgra >> 16) as u8;
                out[1] = (bgra >> 8) as u8;
                out[2] = bgra as u8;
                out[3] = 255;
            }
            Ok(&self.rgba_packet)
        }

        /// Captures into a standard 32-bpp BMP payload (HTTP fallback & backwards compatibility).
        pub fn capture_bmp_vec(
            &mut self,
            source_id: &str,
            max_width: i32,
        ) -> Result<Vec<u8>, String> {
            let (dst_w, dst_h) = self.capture_source_dib(source_id, max_width)?;
            let pixel_bytes = (dst_w as usize) * (dst_h as usize) * 4;
            let header_total = 54u32;
            let file_size = header_total + pixel_bytes as u32;
            let mut bmp = Vec::with_capacity(file_size as usize);
            bmp.extend_from_slice(b"BM");
            bmp.extend_from_slice(&file_size.to_le_bytes());
            bmp.extend_from_slice(&0u32.to_le_bytes());
            bmp.extend_from_slice(&header_total.to_le_bytes());
            bmp.extend_from_slice(&40u32.to_le_bytes());
            bmp.extend_from_slice(&dst_w.to_le_bytes());
            bmp.extend_from_slice(&(-dst_h).to_le_bytes());
            bmp.extend_from_slice(&1u16.to_le_bytes());
            bmp.extend_from_slice(&32u16.to_le_bytes());
            bmp.extend_from_slice(&0u32.to_le_bytes());
            bmp.extend_from_slice(&(pixel_bytes as u32).to_le_bytes());
            bmp.extend_from_slice(&2835i32.to_le_bytes());
            bmp.extend_from_slice(&2835i32.to_le_bytes());
            bmp.extend_from_slice(&0u32.to_le_bytes());
            bmp.extend_from_slice(&0u32.to_le_bytes());

            let src_pixels = unsafe { std::slice::from_raw_parts(self.dst_bits, pixel_bytes) };
            let start = bmp.len();
            bmp.extend_from_slice(src_pixels);
            let (rgba_chunks, _) = bmp[start..].as_chunks_mut::<4>();
            for px in rgba_chunks {
                px[3] = 255;
            }
            Ok(bmp)
        }
    }

    impl Drop for CaptureSession {
        fn drop(&mut self) {
            unsafe {
                self.release_dst_surface();
                self.release_full_surface();
            }
        }
    }

    thread_local! {
        static TL_CAPTURE: RefCell<CaptureSession> = RefCell::new(CaptureSession::new());
    }

    pub fn capture_bmp(source_id: &str, max_width: i32) -> Result<Vec<u8>, String> {
        TL_CAPTURE.with(|cell| cell.borrow_mut().capture_bmp_vec(source_id, max_width))
    }

    fn scale_dims(src_w: i32, src_h: i32, max_w: i32) -> (i32, i32) {
        if src_w <= max_w {
            (src_w.max(2), src_h.max(2))
        } else {
            let dst_h = ((src_h as i64 * max_w as i64) / src_w as i64).max(2) as i32;
            (max_w, dst_h)
        }
    }
}

pub fn list_capture_sources() -> Vec<CaptureSourceInfo> {
    #[cfg(target_os = "windows")]
    {
        win::list_sources()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Vec::new()
    }
}

pub fn capture_source_bmp(source_id: &str, max_width: i32) -> Result<Vec<u8>, String> {
    #[cfg(target_os = "windows")]
    {
        win::capture_bmp(source_id, max_width)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (source_id, max_width);
        Err("Native screen capture is supported on Windows".into())
    }
}

#[cfg(target_os = "windows")]
pub use win::CaptureSession;

#[cfg(not(target_os = "windows"))]
pub struct CaptureSession;

#[cfg(not(target_os = "windows"))]
impl CaptureSession {
    pub fn new() -> Self {
        Self
    }

    pub fn capture_rgba_packet(
        &mut self,
        _source_id: &str,
        _max_width: i32,
    ) -> Result<&[u8], String> {
        Err("Native screen capture is supported on Windows".into())
    }
}
