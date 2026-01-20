import { REST, Routes } from 'discord.js';
import { Config } from './config';
import { command as pvcSetup } from './commands/pvc_setup';
import { command as adminStrictness } from './commands/admin_strictness';
import { command as pvcStatus } from './commands/pvc_status';
import { command as pvcCommandChannel } from './commands/pvc_command_channel';
import { command as pvcStaffRole } from './commands/pvc_staff_role';
import { command as pvcCleanup } from './commands/pvc_setup_delete';
import { command as invite } from './commands/invite';
import { command as refreshPvc } from './commands/refresh_pvc';
import { command as permanentAccess } from './commands/permanent_access';
import prisma from './utils/database';

const commands = [
    pvcSetup.data.toJSON(),
    adminStrictness.data.toJSON(),
    pvcStatus.data.toJSON(),
    pvcCommandChannel.data.toJSON(),
    pvcStaffRole.data.toJSON(),
    pvcCleanup.data.toJSON(),
    invite.data.toJSON(),
    refreshPvc.data.toJSON(),
    permanentAccess.data.toJSON(),
];

const rest = new REST().setToken(Config.token);

async function deployCommands() {
    try {
        const route = Config.guildId
            ? Routes.applicationGuildCommands(Config.clientId, Config.guildId)
            : Routes.applicationCommands(Config.clientId);

        await rest.put(route, { body: commands });

        await prisma.$disconnect();
        process.exit(0);
    } catch (error) {
        await prisma.$disconnect();
        process.exit(1);
    }
}

deployCommands();
