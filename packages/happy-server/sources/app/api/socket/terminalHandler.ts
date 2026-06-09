import { Server, Socket } from 'socket.io';

/**
 * Relays interactive-terminal streaming events between a user's app
 * connections and their machine daemons. Rooms are namespaced by the
 * server-trusted userId, so a user can only target their own machine
 * (ownership enforced by routing). The server relays ciphertext only.
 */
export function terminalHandler(userId: string, socket: Socket, io: Server) {
    const machineRoom = (machineId: string) => `user:${userId}:machine:${machineId}`;
    const userScopedRoom = `user:${userId}:user-scoped`;

    // app → daemon
    socket.on('terminal-input', (data: { machineId: string; terminalId: string; data: string }) => {
        if (!data?.machineId || !data?.terminalId) return;
        io.to(machineRoom(data.machineId)).emit('terminal-input', data);
    });
    socket.on('terminal-resize', (data: { machineId: string; terminalId: string; cols: number; rows: number }) => {
        if (!data?.machineId || !data?.terminalId) return;
        io.to(machineRoom(data.machineId)).emit('terminal-resize', data);
    });

    // daemon → app (only honor these from an actual machine socket)
    const isMachine = (socket.data.clientType as string) === 'machine-scoped';
    socket.on('terminal-output', (data: { machineId: string; terminalId: string; data: string; seq: number }) => {
        if (!isMachine || (socket.data.machineId as string) !== data?.machineId) return;
        io.to(userScopedRoom).emit('terminal-output', data);
    });
    socket.on('terminal-exit', (data: { machineId: string; terminalId: string; exitCode: number }) => {
        if (!isMachine || (socket.data.machineId as string) !== data?.machineId) return;
        io.to(userScopedRoom).emit('terminal-exit', data);
    });
}
