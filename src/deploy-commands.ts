import { REST, Routes } from 'discord.js';
import { Config } from './config';
import { command as pvcSetup } from './commands/pvc_setup';
import { command as pvcStatus } from './commands/pvc_status';
import { command as pvcCommandChannel } from './commands/pvc_command_channel';
import { command as pvcStaffRole } from './commands/pvc_staff_role';
import { command as pvcCleanup } from './commands/pvc_setup_delete';
import { command as refreshPvc } from './commands/refresh_pvc';
import { command as teamSetup } from './commands/team_setup';
import { command as teamStatus } from './commands/team_status';
import { command as teamSetupDelete } from './commands/team_setup_delete';
import { command as teamVcCommandChannel } from './commands/team_vc_command_channel';
import { command as pvcOsTransfer } from './commands/pvc_os_transfer';
import { command as pvcPause } from './commands/pvc_pause';
import { command as pvcResume } from './commands/pvc_resume';
import { command as ping } from './commands/ping';
const commands = [
    pvcSetup.data.toJSON(),
    pvcStatus.data.toJSON(),
    pvcCommandChannel.data.toJSON(),
    pvcStaffRole.data.toJSON(),
    pvcCleanup.data.toJSON(),
    refreshPvc.data.toJSON(),
    teamSetup.data.toJSON(),
    teamStatus.data.toJSON(),
    teamSetupDelete.data.toJSON(),
    teamVcCommandChannel.data.toJSON(),
    pvcOsTransfer.data.toJSON(),
    pvcPause.data.toJSON(),
    pvcResume.data.toJSON(),
    ping.data.toJSON(),
];
const rest = new REST().setToken(Config.token);
async function deployCommands() {
    try {
        console.log(`Started refreshing ${commands.length} application (/) commands.`);
        const route = Config.guildId
            ? Routes.applicationGuildCommands(Config.clientId, Config.guildId)
            : Routes.applicationCommands(Config.clientId);
        await rest.put(route, { body: commands });
        console.log(`Successfully reloaded ${commands.length} application (/) commands.`);
        process.exit(0);
    } catch (error) {
        console.error('Failed to deploy commands:', error);
        process.exit(1);
    }
}
deployCommands();
