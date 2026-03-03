Mandelogue Web Editor Prompt

Build a production-ready browser-based IDE using HTML, CSS, and JavaScript.

Tech requirements:
- Monaco Editor for the code editor (ES module build from CDN)
- xterm.js for terminal emulator
- v86 for in-browser Linux VM
- No TypeScript unless compiling to JavaScript
- Clean architecture and modular JS files
- Dark mode only
- Absolutely NO rounded corners anywhere
- No inline styles
- No global variables
- Use modern ES modules
- Responsive layout using CSS Grid or Flexbox
- Production structure (separate files, clean separation of concerns)

UI Layout Requirements:

Topbar:
- Horizontal bar at top
- Left side: tabs "File", "Edit"
- Ability to dynamically add additional tabs (e.g., "Tools", "Compilers")
- In the center: display the currently open file name
- In the File tab dropdown:
    - "Open Folder"
    - "Save"
    - "New File"

Left Panel:
- File explorer tree
- Shows folder structure
- When user selects "Open Folder":
    - Use browser File System Access API
    - Recursively read folder contents
    - Mount the folder into v86 Linux filesystem under:
      /home/user/<folder_name>
    - Reflect folder contents in file explorer
- Clicking a file loads it into Monaco
- Track currently open file

Center Panel:
- Monaco Editor
- Dark theme
- No minimap
- No rounded UI
- Tabs for multiple open files
- Active tab highlighted

Bottom Panel:
- Terminal using xterm.js
- Connected to v86 serial console
- Resizable via drag handle
- Default height: 30% of viewport

v86 Integration:
- Boot minimal Linux image
- Preconfigured /home/user directory
- When folder imported, write files into virtual filesystem
- Sync Monaco save → write to v86 FS
- Terminal should allow running:
    python
    gcc
    lua
- Ensure VM runs fully client-side

Styling Requirements:
- Dark theme (#111 background base)
- Panels separated by 1px solid #222 borders
- No shadows
- No rounded corners
- Clean monospace font
- Flat UI
- Hover states subtle
- No gradients

Architecture Requirements:
- index.html
- /css/styles.css
- /js/main.js
- /js/editor.js
- /js/terminal.js
- /js/filesystem.js
- /js/vm.js
- No spaghetti code
- Event-driven architecture
- Clean separation between UI and VM logic
- Proper error handling
- No console spam

Production Readiness:
- Handle large folders safely
- Prevent freezing on recursive reads
- Use async/await
- Graceful fallback if File System Access API not supported
- Memory limits for VM configurable
- Clean teardown when page unloads

Extra:
- Allow dynamic tab creation in topbar for future tools
- Add placeholder "Tools" tab ready for compiler installation management
- Make layout robust and scalable

Return:
- Complete file structure
- Fully working HTML
- All JS modules
- All CSS
- Clear comments where needed
- No unnecessary explanations outside code