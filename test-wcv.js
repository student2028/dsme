const { app, WebContentsView } = require('electron');
app.whenReady().then(() => {
  const v = new WebContentsView();
  console.log('webContents exists:', !!v.webContents);
  try { v.webContents.close(); } catch(e) {}
  console.log('webContents after close:', !!v.webContents);
  app.quit();
});
