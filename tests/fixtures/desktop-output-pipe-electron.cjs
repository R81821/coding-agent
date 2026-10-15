const { app } = require("electron");
const guard = {};
new Function("exports", Buffer.from(process.argv[2], "base64").toString("utf8"))(guard);
guard.guardProcessOutput();
app.disableHardwareAcceleration();
process.on("message", message => {
  if (message !== "closed") return;
  console.log("Electron stdout after launcher closure");
  console.warn("Electron warning after launcher closure");
  process.emitWarning("Node warning after launcher closure");
  setTimeout(() => {
    process.stdout.write("late Electron stdout");
    process.stderr.write("late Electron stderr");
    process.emitWarning("late Node warning");
    setTimeout(() => process.send("survived", () => app.exit(0)), 30);
  }, 30);
});
app.whenReady().then(() => process.send("ready"));
